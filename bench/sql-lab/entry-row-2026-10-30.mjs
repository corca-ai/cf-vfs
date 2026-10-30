import { writeFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node entry-row-2026-10-30.mjs ROOT LAB
//
// What the statements behind stat and readFile cost on Cloudflare, without the
// filesystem's JavaScript: the entry as JSON (stat), as columns (unbound
// readFile, credential-bound stat), a narrow row, and the chunk read. ROOT is
// a built checkout, for the library's own column lists.

const [root, name] = process.argv.slice(2);
const { ENTRY_COLUMNS, ENTRY_JSON } = await import(`${root}/dist/vfs/sql-schema.js`);
const w = lab(name);
const PATH = "/wiki/legal/note-0001.md";
const by = "FROM vfs_entries e INDEXED BY vfs_entries_path WHERE e.path = ?";
const cases = {
  "entry as json_object (stat)": `SELECT ${ENTRY_JSON} AS entry ${by}`,
  "entry as columns": `SELECT ${ENTRY_COLUMNS} ${by}`,
  "narrow row (id, kind, size)": `SELECT e.id, e.kind, e.size_bytes ${by}`,
  "chunks by entry id":
    "SELECT body FROM vfs_inline_chunks WHERE entry_id = (SELECT id FROM vfs_entries WHERE path = ?) ORDER BY chunk_index",
};
const results = {};
const ping = (await w.sql([], {})).ms;
for (const [label, sql] of Object.entries(cases)) {
  const samples = [];
  for (let run = 0; run < 3; run += 1)
    samples.push((await w.sql([[sql, [PATH]]], { repeat: 1000, maxRows: 1 })).ms);
  const ms = [...samples].sort((a, b) => a - b)[1];
  results[label] = { ms, samples, perStatement: (ms - ping) / 1000 };
  console.log(
    `${label.padEnd(32)} x1000 ${String(ms).padStart(5)} ms  ${((ms - ping) / 1000).toFixed(3)} ms each`,
  );
}
writeFileSync(
  new URL("./entry-row-2026-10-30.json", import.meta.url),
  `${JSON.stringify(results, null, 1)}\n`,
);
