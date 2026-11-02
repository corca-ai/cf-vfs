import { appendFileSync, readFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node one-blob-2026-11-03.mjs LAB OUT.jsonl [FIXTURE.json] [PAIRS]
//
// Whether reading a batch of bodies as one BLOB is cheaper than one BLOB per
// chunk row, as readMany's bodies statement reads them now. Seeds 200 pages
// of FIXTURE when given, splits their ids into readMany's batches (64, 64,
// 64, 8) and times one request per arm, each running every batch REPEAT
// times:
//   rows      — `entry_id, chunk_index, body` per chunk (production),
//   one-blob  — `group_concat` of the bodies cast to BLOB, with a JSON array
//               of each chunk's id, index and length,
//   lengths   — `length(body)` per chunk (the page-read floor),
//   empty     — `SELECT 1` as many times (the request's own cost).
// Arms alternate in a rotating order within each pair. At most five pairs:
// on Cloudflare this is a small check of a pattern measured locally.

const [name, out, fixture, pairsArg] = process.argv.slice(2);
if (!name || !out) throw new Error("usage: LAB OUT.jsonl [FIXTURE.json] [PAIRS]");
const pairs = Math.min(Number(pairsArg ?? 5), 5);
const PAGES = 200;
const REPEAT = 10;
const w = lab(name);
if (fixture !== undefined) {
  const { files } = JSON.parse(readFileSync(fixture, "utf8"));
  const all = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1));
  const step = Math.floor(all.length / PAGES);
  const chosen = Array.from({ length: PAGES }, (_, index) => all[index * step]);
  await w.seed(Object.fromEntries(chosen.map(([path, content]) => [`wiki/${path}`, content])));
}
const listed = await w.sql(
  [["SELECT id, size_bytes FROM vfs_entries WHERE kind = 'file' ORDER BY path LIMIT 1000"]],
  { maxRows: 1000 },
);
const rows = listed.results[0].rows;
if (rows.length !== PAGES) throw new Error(`expected ${PAGES} files, found ${rows.length}`);
const ids = rows.map((row) => row.id);
const bytes = rows.reduce((total, row) => total + row.size_bytes, 0);
const batches = [];
for (let at = 0; at < ids.length; at += 64) batches.push(ids.slice(at, at + 64));

const wanted = (batch) => `WITH wanted(id) AS (VALUES ${batch.map(() => "(?)").join(",")})`;
const FROM = "FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id";
const ORDER = "ORDER BY c.entry_id, c.chunk_index";
const arms = {
  rows: (batch) => `${wanted(batch)} SELECT c.entry_id, c.chunk_index, c.body ${FROM}`,
  "one-blob": (batch) =>
    `${wanted(batch)} SELECT CAST(group_concat(c.body, '' ${ORDER}) AS BLOB) AS bodies,
       json_group_array(json_array(c.entry_id, c.chunk_index, length(c.body)) ${ORDER}) AS layout
     ${FROM}`,
  lengths: (batch) => `${wanted(batch)} SELECT c.entry_id, c.chunk_index, length(c.body) ${FROM}`,
};
const statements = (arm) =>
  arm === "empty"
    ? batches.map(() => ["SELECT 1"])
    : batches.map((batch) => [arms[arm](batch), batch]);

// The one-BLOB arm must carry every byte the rows carry.
const check = await w.sql(statements("one-blob"), { maxRows: 1 });
const carried = check.results.reduce((total, result) => total + result.rows[0].bodies.blobBytes, 0);
if (carried !== bytes) throw new Error(`one-blob carried ${carried} of ${bytes} bytes`);
console.log(`${PAGES} pages, ${bytes} bytes, ${batches.length} batches, repeat ${REPEAT}`);

const order = ["rows", "one-blob", "lengths", "empty"];
for (let pair = 0; pair < pairs; pair += 1) {
  const turn = order.map((_, index) => order[(index + pair) % order.length]);
  for (const arm of turn) {
    const started = performance.now();
    await w.sql(statements(arm), { repeat: REPEAT, maxRows: 1 });
    const ms = performance.now() - started;
    appendFileSync(
      out,
      `${JSON.stringify({ pair, arm, ms, repeat: REPEAT, batches: batches.length })}\n`,
    );
  }
  console.log(`pair ${pair} done`);
}
