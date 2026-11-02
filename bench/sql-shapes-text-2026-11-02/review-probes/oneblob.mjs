import { lab } from "../../sql-lab/lab.mjs";

const w = lab("pipes");
// Exactness of concatenating blobs into one BLOB in SQLite.
const q = `WITH t(i, b) AS (VALUES (1, x'00FF61'), (2, x'E961'), (3, x'F09F98'), (4, x''), (5, x'EFBBBF00'))
SELECT hex(CAST(group_concat(b, '') AS BLOB)) AS gc, typeof(group_concat(b, '')) AS ty,
       hex((SELECT CAST(group_concat(b, '' ORDER BY i DESC) AS BLOB) FROM t)) AS gc_desc,
       1 AS v FROM t`;
console.log((await w.sql([[q]], { maxRows: 1 })).results[0].rows[0]);
// Real bodies: compare per-row blobs vs one concatenated blob.
const ids = (
  await w.sql(
    [
      [
        "SELECT id FROM vfs_entries WHERE kind='file' AND path >= '/wiki/' AND path < '/wiki0' ORDER BY path LIMIT 64 OFFSET 5000",
      ],
    ],
    { maxRows: 64 },
  )
).results[0].rows.map((r) => r.id);
const vals = ids.map(() => "(?)").join(",");
const q2 = `WITH wanted(id) AS (VALUES ${vals}) SELECT sum(length(c.body)) AS total, length(CAST(group_concat(c.body, '' ORDER BY c.entry_id, c.chunk_index) AS BLOB)) AS one FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`;
console.log((await w.sql([[q2, ids]], { maxRows: 1 })).results[0].rows[0]);
