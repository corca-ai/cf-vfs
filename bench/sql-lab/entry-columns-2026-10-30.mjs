import { writeFileSync } from "node:fs";
import { ENTRY_COLUMNS, ENTRY_JSON } from "../../src/vfs/sql-schema.ts";
import { lab } from "./lab.mjs";

// Usage: node --experimental-strip-types entry-columns-2026-10-30.mjs LAB
//
// What one readMany batch costs as SQL on Cloudflare: 64 entries by path as
// nineteen columns or as one JSON string, and their bodies by id. Each is run
// 50 times in a request; medians of five requests minus an empty request.

const [name] = process.argv.slice(2);
const w = lab(name);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const paths = (
  await w.sql([["SELECT path FROM vfs_entries WHERE kind = 'file' AND path >= '/wiki/' AND path < '/wiki0' ORDER BY path LIMIT 64 OFFSET 5000"]], { maxRows: 64 })
).results[0].rows.map((row) => row.path);
const ids = (
  await w.sql([[`SELECT id FROM vfs_entries WHERE path IN (${paths.map(() => "?").join(",")})`, paths]], { maxRows: 64 })
).results[0].rows.map((row) => row.id);
const values = paths.map(() => "(?)").join(",");
const FROM = `FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path ON e.path = requested.path`;
const variants = {
  empty: [],
  "entries as columns": [[`WITH requested(path) AS (VALUES ${values}) SELECT ${ENTRY_COLUMNS} ${FROM}`, paths]],
  "entries as json": [[`WITH requested(path) AS (VALUES ${values}) SELECT ${ENTRY_JSON} AS entry ${FROM}`, paths]],
  "entry ids only": [[`WITH requested(path) AS (VALUES ${values}) SELECT e.id ${FROM}`, paths]],
  "bodies by id": [[`WITH wanted(id) AS (VALUES ${ids.map(() => "(?)").join(",")}) SELECT c.entry_id, c.chunk_index, c.body FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`, ids]],
  "body lengths by id": [[`WITH wanted(id) AS (VALUES ${ids.map(() => "(?)").join(",")}) SELECT length(c.body) AS n FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`, ids]],
  "body prefixes by id": [[`WITH wanted(id) AS (VALUES ${ids.map(() => "(?)").join(",")}) SELECT substr(c.body, 1, 16) AS b FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`, ids]],
  "bodies as text by id": [[`WITH wanted(id) AS (VALUES ${ids.map(() => "(?)").join(",")}) SELECT CAST(c.body AS TEXT) AS b FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`, ids]],
  "bodies as one text": [[`WITH wanted(id) AS (VALUES ${ids.map(() => "(?)").join(",")}) SELECT group_concat(CAST(c.body AS TEXT), char(0)) AS b FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`, ids]],
  "bodies only by id": [[`WITH wanted(id) AS (VALUES ${ids.map(() => "(?)").join(",")}) SELECT c.body FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`, ids]],
};
const times = {};
for (let round = 0; round < 5; round += 1) {
  for (const [label, statements] of Object.entries(variants)) {
    (times[label] ??= []).push((await w.sql(statements, { repeat: label === "empty" ? 1 : 50, maxRows: 1 })).ms);
  }
}
const ping = median(times.empty);
const results = {};
for (const [label, samples] of Object.entries(times)) {
  const ms = median(samples);
  results[label] = { ms, samples, perBatchMs: label === "empty" ? null : (ms - ping) / 50 };
  console.log(`${label.padEnd(20)} ${String(ms).padStart(6)} ms  ${label === "empty" ? "" : `${results[label].perBatchMs.toFixed(3)} ms per 64-path batch`}  [${samples.join(", ")}]`);
}
writeFileSync(new URL(`./entry-columns-2026-10-30-${name}.json`, import.meta.url), `${JSON.stringify(results, null, 1)}\n`);
