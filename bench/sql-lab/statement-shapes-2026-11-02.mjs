import { lab } from "./lab.mjs";

// Usage: node statement-shapes-2026-11-02.mjs LAB [ROUNDS]
//
// What a statement's shape costs in a SQL lab holding the 10,000-page wiki:
// the entry lookup statMany and readMany issue, over 64 paths, as
//   fixed    — the same text every time (a prepared-statement cache hit),
//   unique   — a new text every time (a comment makes it so: a prepare each),
//   varying  — 32 to 64 placeholders, as a last or partly admitted batch is,
//   padded   — always 64 placeholders, the unused ones NULL.
// Each request runs 64 statements; the request's milliseconds are the cost.
// Meant for a local `cf dev` lab (LAB_URL).

const [name, roundsArg] = process.argv.slice(2);
if (!name) throw new Error("usage: LAB [ROUNDS]");
const rounds = Number(roundsArg ?? 7);
const w = lab(name);
const ENTRY = "json_array(e.id, e.path, e.kind, e.size_bytes, e.mode, e.revision)";
const lookup = (n, tag = "") =>
  `${tag}WITH requested(path) AS (VALUES ${Array.from({ length: n }, () => "(?)").join(",")})
   SELECT ${ENTRY} AS entry FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path
   ON e.path = requested.path`;
const paths = (
  await w.sql([["SELECT path FROM vfs_entries WHERE kind = 'file' ORDER BY path LIMIT 1000"]], {
    maxRows: 1000,
  })
).results[0].rows.map((row) => row.path);
const take = (index, n) => paths.slice((index * 64) % 936, ((index * 64) % 936) + n);
// Unique to this run too, so a second run against the same object prepares again.
const run = Date.now().toString(36);
let serial = 0;
const variants = {
  fixed: (i) => [lookup(64), take(i, 64)],
  unique: (i) => {
    serial += 1;
    return [lookup(64, `/* ${run}-${serial} */ `), take(i, 64)];
  },
  varying: (i) => [lookup(32 + (i % 33)), take(i, 32 + (i % 33))],
  padded: (i) => [
    lookup(64),
    [...take(i, 32 + (i % 33)), ...Array.from({ length: 64 - (32 + (i % 33)) }, () => null)],
  ],
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const samples = Object.fromEntries(Object.keys(variants).map((key) => [key, []]));
for (let round = 0; round < rounds; round += 1) {
  const order = Object.keys(variants);
  if (round % 2 === 1) order.reverse();
  for (const key of order) {
    const statements = Array.from({ length: 64 }, (_, i) => variants[key](i + round * 64));
    const started = performance.now();
    const { results } = await w.sql(statements, { maxRows: 1 });
    samples[key].push(performance.now() - started);
    if (round === 0) console.log(`${key}: rows ${results.reduce((n, r) => n + r.rowCount, 0)}`);
  }
}
for (const [key, values] of Object.entries(samples))
  console.log(
    `${key.padEnd(8)} median ${median(values).toFixed(2)} ms per 64 statements [${values.map((v) => v.toFixed(1)).join(", ")}]`,
  );
