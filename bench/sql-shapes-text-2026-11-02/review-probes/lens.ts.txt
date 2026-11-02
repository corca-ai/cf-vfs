import { ENTRY_COLUMNS, ENTRY_JSON } from "../../../src/vfs/sql-schema.js";

const v = (n: number) => Array.from({ length: n }, () => "(?)").join(",");
const stat = (n: number) => `WITH requested(path) AS (VALUES ${v(n)})
         SELECT ${ENTRY_JSON} AS entry
         FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path
         ON e.path = requested.path`;
const entry = (n: number) => `WITH requested(path) AS (VALUES ${v(n)})
         SELECT ${ENTRY_JSON} AS entry
         FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path
           ON e.path = requested.path`;
const body = (n: number) => `WITH wanted(id) AS (VALUES ${v(n)})
           SELECT c.entry_id, c.chunk_index, c.body
           FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`;
let s = 0,
  e = 0,
  b = 0;
for (let n = 1; n <= 64; n++) {
  s += stat(n).length;
  e += entry(n).length;
  b += body(n).length;
}
console.log({
  ENTRY_JSON: ENTRY_JSON.length,
  ENTRY_COLUMNS: ENTRY_COLUMNS.length,
  statMany: s,
  entryBatch: e,
  bodyBatch: b,
  total: s + e + b,
  stat64: stat(64).length,
});
