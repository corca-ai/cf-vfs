import { writeFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node bulk-read-2026-10-30.mjs LAB [TRIALS]
//
// Measures, in a SQL lab Durable Object holding the 10,000-page S3 wiki under
// /wiki, what reading every page costs through `readFile` one call each and
// through `readMany`, then the shell commands that walk the wiki — `grep -r`
// and a cold `awiki` load — with bulk reads offered and withheld. Arms
// alternate within each trial, and the first arm alternates across trials.
// Exploration only: adoption follows the performance protocol.

const [name, trialsArg] = process.argv.slice(2);
const trials = Number(trialsArg ?? 3);
const w = lab(name);

const RANGE = "e.path >= '/wiki/' AND e.path < '/wiki0' AND e.kind = 'file'";
const all = [];
for (let offset = 0; offset < 10_000; offset += 1000) {
  const page = await w.sql(
    [[`SELECT e.path FROM vfs_entries e WHERE ${RANGE} ORDER BY e.path LIMIT 1000 OFFSET ${offset}`]],
    { maxRows: 1000 },
  );
  all.push(...page.results[0].rows.map((row) => row.path));
}
if (all.length !== 10_000) throw new Error(`expected 10,000 pages, found ${all.length}`);

async function readAll(mode) {
  const start = Date.now();
  let bytes = 0;
  for (let at = 0; at < all.length; at += 2000) bytes += (await w.read(all.slice(at, at + 2000), mode)).bytes;
  return { ms: Date.now() - start, bytes };
}

const SCRIPTS = {
  "grep -rlF link": "grep -rlF '[[note-0001' /wiki | wc -l",
  "grep -rc owner": "grep -rc '^owner:' /wiki | tail -1",
  "awiki lint cold": "awiki lint -r -root /wiki >/dev/null; echo $?",
};

const samples = {};
const record = (label, value) => {
  (samples[label] ??= []).push(value);
  console.log(`${label.padEnd(36)} ${String(value.ms).padStart(6)} ms  ${value.detail ?? ""}`);
};

for (let trial = 0; trial < trials; trial += 1) {
  const reads = trial % 2 === 0 ? ["stream", "many-stream", "many"] : ["many", "many-stream", "stream"];
  for (const mode of reads) {
    const result = await readAll(mode);
    record(`read ${mode}`, { ms: result.ms, detail: `${result.bytes} bytes` });
  }
  for (const [label, script] of Object.entries(SCRIPTS)) {
    const arms = trial % 2 === 0 ? [false, true] : [true, false];
    for (const bulk of arms) {
      const result = await w.shell(script, { bulk });
      record(`${label} ${bulk ? "bulk" : "per-file"}`, {
        ms: result.ms,
        detail: `exit ${result.exitCode} ${JSON.stringify(result.stdout.trim())} ${result.stderr.trim().slice(0, 120)}`,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log("\nmedians");
const summary = {};
for (const [label, values] of Object.entries(samples)) {
  summary[label] = { median: median(values.map((v) => v.ms)), samples: values.map((v) => v.ms) };
  console.log(`${label.padEnd(36)} ${String(summary[label].median).padStart(6)} ms  [${summary[label].samples.join(", ")}]`);
}
writeFileSync(
  new URL(`./bulk-read-2026-10-30-${name}.json`, import.meta.url),
  `${JSON.stringify({ summary, samples }, null, 1)}\n`,
);
