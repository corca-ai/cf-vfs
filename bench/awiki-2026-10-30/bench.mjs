import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

// Usage: node bench.mjs ROOT [REPS], where ROOT is a built checkout (dist/).
//
// Times `awiki` over the S3 agent-evaluation wiki (2,000 pages, 9.9 MB) in the
// local SQLite filesystem: a cold run on a fresh filesystem, warm runs, runs
// after edits, and the grep pipelines an agent writes for the same questions.
// SQL statements and rows read are counted per run. When the native awiki
// 0.5.0 is on PATH the same commands run against a disk copy for reference.

const root = process.argv[2];
const reps = Number(process.argv[3] ?? 7);
const { NodeSqlFileSystem } = await import(`${root}/dist/testing/node.js`);
const { Shell } = await import(`${root}/dist/shell/shell.js`);
const { defaultShellCommands } = await import(`${root}/dist/shell/commands/default.js`);
const { awkCommand } = await import(`${root}/dist/shell/commands/awk.js`);
const { awikiCommand } = await import(`${root}/dist/shell/commands/awiki.js`);
const files = JSON.parse(
  gunzipSync(
    readFileSync(new URL("../regex-prefix-2026-10-29/local/s3-files.json.gz", import.meta.url)),
  ).toString(),
);

async function workspace() {
  const sql = { statements: 0, rows: 0 };
  const fs = new NodeSqlFileSystem({
    onStatement(_query, rows) {
      sql.statements += 1;
      sql.rows += rows;
    },
  });
  for (const [path, content] of Object.entries(files)) {
    await fs.writeFile(`/w/${path}`, content, { createParents: true });
  }
  const shell = new Shell({
    fileSystem: fs,
    commands: [...defaultShellCommands, awkCommand, awikiCommand],
    limits: { maxTotalIoBytes: 1 << 30 },
  });
  return { fs, shell, sql };
}

async function measure(space, script) {
  const before = { ...space.sql };
  const start = performance.now();
  const result = await space.shell.executeText({ script });
  const ms = performance.now() - start;
  if (result.exitCode > 1 || result.stderr !== "") {
    throw new Error(`${script}: exit ${result.exitCode} ${result.stderr}`);
  }
  return {
    ms,
    statements: space.sql.statements - before.statements,
    rows: space.sql.rows - before.rows,
    stdout: result.stdout,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(name, runs) {
  return {
    name,
    ms: median(runs.map((run) => run.ms)),
    min: Math.min(...runs.map((run) => run.ms)),
    max: Math.max(...runs.map((run) => run.ms)),
    statements: median(runs.map((run) => run.statements)),
    rows: median(runs.map((run) => run.rows)),
    outputBytes: runs[0].stdout.length,
  };
}

const results = [];
const record = (name, runs) => {
  const row = summarize(name, runs);
  results.push(row);
  console.log(
    `${name.padEnd(44)} ${row.ms.toFixed(1).padStart(8)} ms [${row.min.toFixed(1)}-${row.max.toFixed(1)}] ` +
      `${String(row.statements).padStart(6)} stmts ${String(row.rows).padStart(7)} rows`,
  );
};

// Cold: a fresh filesystem has no cached pages.
{
  const runs = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const space = await workspace();
    runs.push(await measure(space, "awiki lint -r -root /w >/dev/null"));
    space.fs.close();
  }
  record("cold: lint -r", runs);
}

const space = await workspace();
await measure(space, "awiki lint -r -root /w >/dev/null");
const warm = {
  "warm: lint -r": "awiki lint -r -root /w >/dev/null",
  "warm: links -r (one page)": "awiki links -r -root /w spec-0000 >/dev/null",
  "warm: wanted -r": "awiki wanted -r -root /w >/dev/null",
  "warm: path -r": "awiki path -r -root /w spec-0000 note-0001 >/dev/null",
  "warm: suggest -r (no near-duplicates)":
    "awiki suggest -r -root /w --filter sampled-diameter,wanted-pressure,long-pages,short-stubs >/dev/null",
  "warm: suggest -r --filter near-duplicates":
    "awiki suggest -r -root /w --filter near-duplicates >/dev/null",
  "warm: format -r (already formatted check)": "awiki format -r -root /w >/dev/null",
  "pipeline: backlinks of one page (grep -rl)": "grep -rlE '\\[\\[spec-0000[]|#]' /w >/dev/null",
  "pipeline: link targets ranked (grep|sort|uniq)":
    "grep -rhoE '\\[\\[[^]|#]+' /w | sort | uniq -c | sort -rn | head >/dev/null",
};
// Formatting rewrites the wiki once; measure afterwards so every run sees the same pages.
await measure(space, "awiki format -r -root /w >/dev/null");
for (const [name, script] of Object.entries(warm)) {
  const runs = [];
  for (let rep = 0; rep < reps; rep += 1) runs.push(await measure(space, script));
  record(name, runs);
}

// Renames touch only the linking pages; rename back so each run starts alike.
{
  const runs = [];
  for (let rep = 0; rep < reps; rep += 1) {
    runs.push(await measure(space, "awiki rename -r -root /w spec-0000 renamed-0000 >/dev/null"));
    await measure(space, "awiki rename -r -root /w renamed-0000 spec-0000 >/dev/null");
    await measure(space, "awiki lint -r -root /w >/dev/null");
  }
  record("warm: rename -r (and links rewritten)", runs);
}

// Edits invalidate exactly the edited pages.
for (const edited of [1, 100]) {
  const runs = [];
  const targets = Object.keys(files).slice(0, edited);
  for (let rep = 0; rep < reps; rep += 1) {
    for (const path of targets) {
      await space.fs.appendFile(`/w/${path}`, `\nEdit ${rep}.\n`);
    }
    runs.push(await measure(space, "awiki lint -r -root /w >/dev/null"));
  }
  record(`after editing ${edited} page(s): lint -r`, runs);
}
space.fs.close();

// The native CLI on a disk copy, for reference.
const native = [];
const version = spawnSync("awiki", ["version"], { encoding: "utf8" }).stdout?.trim();
if (version === "0.5.0") {
  const base = mkdtempSync(join(tmpdir(), "awiki-bench-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), content);
    }
    spawnSync("awiki", ["format", "-r", "-root", base]);
    for (const [name, args] of Object.entries({
      "native: lint -r": ["lint", "-r"],
      "native: links -r (one page)": ["links", "-r", "spec-0000"],
      "native: wanted -r": ["wanted", "-r"],
      "native: suggest -r (no near-duplicates)": [
        "suggest",
        "-r",
        "--filter",
        "sampled-diameter,wanted-pressure,long-pages,short-stubs",
      ],
      "native: suggest -r --filter near-duplicates": [
        "suggest",
        "-r",
        "--filter",
        "near-duplicates",
      ],
    })) {
      const times = [];
      for (let rep = 0; rep < reps; rep += 1) {
        const start = performance.now();
        spawnSync("awiki", [...args, "-root", base]);
        times.push(performance.now() - start);
      }
      const row = { name, ms: median(times), min: Math.min(...times), max: Math.max(...times) };
      native.push(row);
      console.log(`${name.padEnd(44)} ${row.ms.toFixed(1).padStart(8)} ms`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

writeFileSync(
  new URL("./results.json", import.meta.url),
  `${JSON.stringify({ node: process.version, reps, pages: Object.keys(files).length, results, native }, null, 1)}\n`,
);
