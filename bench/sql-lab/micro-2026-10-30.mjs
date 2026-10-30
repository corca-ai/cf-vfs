import { writeFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node micro-2026-10-30.mjs LAB
//
// Times fixed runtime microbenchmarks inside a SQL lab Durable Object: what
// the shell does per file (a stream, a decoder, an abort listener) and per
// line (an await, an async generator step, a clock read). Each is the median
// of five requests minus the median empty request, divided by its count.

const [name] = process.argv.slice(2);
const w = lab(name);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const KINDS = {
  empty: 1,
  "sync-call": 1_000_000,
  "await-resolved": 1_000_000,
  "async-generator": 1_000_000,
  "date-now": 1_000_000,
  "abort-listener": 100_000,
  "text-decode": 100_000,
  "line-encode": 100_000,
  "line-encode-into": 100_000,
  "line-scan": 100_000,
  "line-ascii-regex": 100_000,
  "copy-body": 10_000,
  "owned-stream": 10_000,
  "default-stream": 10_000,
  "blob-stream": 10_000,
};
const times = {};
for (let round = 0; round < 5; round += 1) {
  for (const [kind, n] of Object.entries(KINDS)) {
    (times[kind] ??= []).push((await w.micro(kind, n)).ms);
  }
}
const ping = median(times.empty);
const results = {};
for (const [kind, n] of Object.entries(KINDS)) {
  const ms = median(times[kind]);
  results[kind] = { n, ms, samples: times[kind], perOpUs: kind === "empty" ? null : ((ms - ping) * 1000) / n };
  console.log(`${kind.padEnd(16)} n=${String(n).padStart(8)} ${String(ms).padStart(6)} ms  ${kind === "empty" ? "" : `${results[kind].perOpUs.toFixed(3)} µs/op`}  [${times[kind].join(", ")}]`);
}
writeFileSync(new URL(`./micro-2026-10-30-${name}.json`, import.meta.url), `${JSON.stringify(results, null, 1)}\n`);
