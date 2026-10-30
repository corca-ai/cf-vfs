import { readFileSync, writeFileSync } from "node:fs";

// Usage: node run.mjs FIXTURES NAME... (for example s3 s3-10k)
//
// Measures awiki on Cloudflare through the agent evaluation Worker: seeds a
// fresh instance with the wiki in batches, runs each step as one execution,
// and reads Worker time, shell time and SQL cost from the execution log. The
// bearer token comes from eval/.secrets.json and is never printed.

const BASE = "https://eval.vfs.borca.ai/api/instances";
const [fixtures, ...names] = process.argv.slice(2);
const token = JSON.parse(
  readFileSync(new URL("../../eval/.secrets.json", import.meta.url), "utf8"),
).AGENT_EVAL_TOKEN;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "cf-vfs-awiki-bench/1",
};

async function call(method, path, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text === "" ? undefined : JSON.parse(text);
}

function batches(files) {
  const out = [];
  let current = [];
  let bytes = 0;
  for (const [path, content] of Object.entries(files)) {
    const size = Buffer.byteLength(content) + path.length + 64;
    if (current.length === 1000 || bytes + size > 7 * 1024 * 1024) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push({ path: `wiki/${path}`, content });
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const STEPS = [
  ["awiki lint, first run", "awiki lint -r -root wiki > /dev/null; echo $?"],
  ["awiki lint, warm 1", "awiki lint -r -root wiki > /dev/null; echo $?"],
  ["awiki lint, warm 2", "awiki lint -r -root wiki > /dev/null; echo $?"],
  ["awiki lint, warm 3", "awiki lint -r -root wiki > /dev/null; echo $?"],
  ["awiki graph: pages nothing links to", "awiki graph -r -root wiki | grep -c ' inbound=0 '"],
  [
    "awiki graph -json: top inbound",
    "awiki graph -r -root wiki -json | jq -r '.documents | sort_by(-.inbound) | .[0] | \"\\(.name) \\(.inbound)\"'",
  ],
  ["awiki links, one page", "awiki links -r -root wiki note-0001 | wc -l"],
  ["edit one page", "echo 'One more line.' >> \"$(find wiki -name '*.md' | sort | head -1)\""],
  ["awiki lint after one edit", "awiki lint -r -root wiki > /dev/null; echo $?"],
  ["grep: backlinks of one page", "grep -rlE '\\[\\[note-0001[]|#]' wiki | wc -l"],
  [
    "grep pipeline: inbound counts",
    "grep -roE '\\[\\[[^]|#]+' --include='*.md' wiki | sed -e 's|^wiki/||' -e 's|\\.md:\\[\\[| |' | awk '{ n = $1; sub(/.*\\//, \"\", n); if (n != $2) print n, $2 }' | sort -u | awk '{ print $2 }' | sort | uniq -c | wc -l",
  ],
];

const results = [];
for (const name of names) {
  const { files } = JSON.parse(readFileSync(`${fixtures}/${name}.json`, "utf8"));
  const { instance } = await call("POST", "", {
    label: `awiki-cf-${name}`,
    ttlSeconds: 6 * 3600,
    files: [],
  });
  const id = instance.id;
  try {
    const seedStart = Date.now();
    for (const batch of batches(files)) await call("POST", `/${id}/files`, { files: batch });
    const seedMs = Date.now() - seedStart;
    const steps = [];
    const run = async (label, script) => {
      const start = Date.now();
      const response = await call("POST", `/${id}/exec`, { script });
      steps.push({
        label,
        roundTripMs: Date.now() - start,
        exitCode: response.exitCode,
        stdout: response.stdout.trim().slice(0, 120),
        stderr: response.stderr.trim().slice(0, 200),
      });
    };
    for (const [label, script] of STEPS) await run(label, script);
    // Idle long enough for the object to be evicted, then run again.
    await new Promise((resolve) => setTimeout(resolve, 240_000));
    await run("awiki lint after 4 minutes idle", STEPS[0][1]);
    await run("awiki lint, warm again", STEPS[0][1]);
    const { entries } = await call("GET", `/${id}/log?after=0&limit=100`);
    for (const [index, step] of steps.entries()) {
      const entry = entries[index];
      Object.assign(step, {
        workerMs: entry?.workerMs ?? null,
        shellMs: entry?.shellMs ?? null,
        statements: entry?.sql?.statements ?? null,
        rowsRead: entry?.sql?.rowsRead ?? null,
      });
    }
    const pages = Object.keys(files).length;
    results.push({
      name,
      pages,
      bytes: Object.values(files).reduce((s, t) => s + t.length, 0),
      seedMs,
      steps,
    });
    console.log(`\n${name}: ${pages} pages, seeded in ${seedMs} ms`);
    for (const step of steps) {
      console.log(
        `${step.label.padEnd(40)} worker ${String(step.workerMs).padStart(6)} ms shell ${String(step.shellMs).padStart(6)} ms ` +
          `stmts ${String(step.statements).padStart(7)} rows ${String(step.rowsRead).padStart(8)} exit ${step.exitCode} ` +
          `out ${JSON.stringify(step.stdout)}${step.stderr ? ` err ${JSON.stringify(step.stderr)}` : ""}`,
      );
    }
  } finally {
    await call("DELETE", `/${id}`).catch((error) => console.error(String(error)));
  }
}
writeFileSync(new URL("./results.json", import.meta.url), `${JSON.stringify(results, null, 1)}\n`);
