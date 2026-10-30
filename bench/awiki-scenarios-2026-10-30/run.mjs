import { readFileSync, writeFileSync } from "node:fs";
import { SOLUTIONS } from "./solutions.mjs";

// Usage: node run.mjs ROOT FIXTURES [REPS]
//
// ROOT is a built cf-vfs checkout (dist/); FIXTURES holds s1.json and s3.json
// from fixtures.py. Each solution runs REPS times on a fresh filesystem with
// the default limits, one shell execution per script, with the wiki at
// /workspace/wiki as the agents had it. The final tree is graded against the
// expected end state, byte for byte.

const [root, fixtures, repsArgument] = process.argv.slice(2);
const reps = Number(repsArgument ?? 5);
const { NodeSqlFileSystem } = await import(`${root}/dist/testing/node.js`);
const { Shell } = await import(`${root}/dist/shell/shell.js`);
const { defaultShellCommands } = await import(`${root}/dist/shell/commands/default.js`);
const { awkCommand } = await import(`${root}/dist/shell/commands/awk.js`);
const { awikiCommand } = await import(`${root}/dist/shell/commands/awiki.js`);
const decoder = new TextDecoder();

async function workspace(files) {
  const sql = { statements: 0, rows: 0 };
  const fs = new NodeSqlFileSystem({
    onStatement(_query, rows) {
      sql.statements += 1;
      sql.rows += rows;
    },
  });
  for (const [path, content] of Object.entries(files)) {
    await fs.writeFile(`/workspace/wiki/${path}`, content, { createParents: true });
  }
  const shell = new Shell({
    fileSystem: fs,
    commands: [...defaultShellCommands, awkCommand, awikiCommand],
  });
  return { fs, shell, sql };
}

async function readTree(fs) {
  const files = {};
  for (const entry of fs.find({ path: "/workspace/wiki", type: "file" })) {
    const read = fs.readFile(entry.path);
    const chunks = [];
    for await (const chunk of read.stream) chunks.push(chunk);
    files[entry.path.slice("/workspace/wiki/".length)] = decoder.decode(Buffer.concat(chunks));
  }
  return files;
}

function grade(actual, expected) {
  const wrong = [];
  for (const path of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if (actual[path] !== expected[path]) wrong.push(path);
  }
  return wrong.sort();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const report = [];
for (const [scenario, solutions] of Object.entries(SOLUTIONS)) {
  const { files, expected } = JSON.parse(readFileSync(`${fixtures}/${scenario}.json`, "utf8"));
  for (const [name, scripts] of Object.entries(solutions)) {
    const runs = [];
    for (let rep = 0; rep < reps; rep += 1) {
      const space = await workspace(files);
      const before = { ...space.sql };
      const steps = [];
      for (const script of scripts) {
        const start = performance.now();
        const result = await space.shell.executeText({ script, cwd: "/workspace" });
        steps.push({
          ms: performance.now() - start,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 300),
        });
      }
      const wrong = grade(await readTree(space.fs), expected);
      runs.push({
        ms: steps.reduce((sum, step) => sum + step.ms, 0),
        statements: space.sql.statements - before.statements,
        rows: space.sql.rows - before.rows,
        steps,
        wrong,
      });
      space.fs.close();
    }
    const row = {
      scenario,
      solution: name,
      executions: scripts.length,
      scriptBytes: scripts.reduce((sum, script) => sum + script.length, 0),
      ms: median(runs.map((run) => run.ms)),
      min: Math.min(...runs.map((run) => run.ms)),
      max: Math.max(...runs.map((run) => run.ms)),
      stepMs: scripts.map((_, index) => median(runs.map((run) => run.steps[index].ms))),
      statements: median(runs.map((run) => run.statements)),
      rows: median(runs.map((run) => run.rows)),
      exitCodes: runs[0].steps.map((step) => step.exitCode),
      stderr: runs[0].steps.map((step) => step.stderr).filter((text) => text !== ""),
      wrongFiles: runs[0].wrong,
    };
    report.push(row);
    console.log(
      `${scenario} ${name.padEnd(42)} ${row.ms.toFixed(0).padStart(7)} ms [${row.min.toFixed(0)}-${row.max.toFixed(0)}] ` +
        `execs=${row.executions} script=${row.scriptBytes}B stmts=${row.statements} ` +
        `exits=${row.exitCodes.join(",")} wrong=${row.wrongFiles.length}${row.wrongFiles.length ? ` ${row.wrongFiles.slice(0, 3).join(" ")}` : ""}` +
        `${row.stderr.length ? ` stderr=${JSON.stringify(row.stderr).slice(0, 200)}` : ""}`,
    );
  }
}
writeFileSync(
  new URL("./results.json", import.meta.url),
  `${JSON.stringify({ node: process.version, reps, report }, null, 1)}\n`,
);
