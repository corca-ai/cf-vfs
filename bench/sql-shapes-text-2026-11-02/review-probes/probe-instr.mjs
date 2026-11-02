import { lab } from "../../sql-lab/lab.mjs";

const w = lab(process.argv[2]);
const q = async (sql, params) => (await w.sql([[sql, params]], { maxRows: 5 })).results[0].rows;
console.log(
  await q(
    `SELECT instr(x'61EFBFBD', x'EFBFBD') a, instr(x'FF61', x'EFBFBD') b, instr(x'E282', x'EFBFBD') c, CASE WHEN instr(x'FF61', x'EFBFBD')=0 THEN CAST(x'FF61' AS TEXT) ELSE x'FF61' END d`,
  ),
);
const files = {};
const page = "Lorem ipsum dolor sit amet, café — “quoted” 中文 text.\n".repeat(90);
for (let i = 0; i < 64; i++) files[`/w/${String(i).padStart(3, "0")}.md`] = page;
await w.seed(files);
const ids = (
  await w.sql([["SELECT id FROM vfs_entries WHERE path LIKE '/w/%' ORDER BY path"]], {
    maxRows: 64,
  })
).results[0].rows.map((r) => r.id);
console.log(
  "bytes/page",
  Buffer.byteLength(page),
  "chunks/entry",
  (
    await q(
      `SELECT max(n) m FROM (SELECT count(*) n FROM vfs_inline_chunks WHERE entry_id IN (${ids.join(",")}) GROUP BY entry_id)`,
    )
  )[0].m,
);
const V = ids.map(() => "(?)").join(",");
const shapes = {
  blob: `WITH wanted(id) AS (VALUES ${V}) SELECT c.entry_id, c.chunk_index, c.body FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`,
  text: `WITH wanted(id) AS (VALUES ${V}) SELECT c.entry_id, c.chunk_index, CAST(c.body AS TEXT) AS body FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`,
  guarded: `WITH wanted(id) AS (VALUES ${V}) SELECT c.entry_id, c.chunk_index, length(c.body) AS bytes, CASE WHEN instr(c.body, x'EFBFBD') = 0 THEN CAST(c.body AS TEXT) ELSE c.body END AS body FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`,
};
const res = Object.fromEntries(Object.keys(shapes).map((k) => [k, []]));
for (let t = 0; t < 12; t++)
  for (const k of t % 2 ? Object.keys(shapes).reverse() : Object.keys(shapes)) {
    const st = Array.from({ length: 16 }, () => [shapes[k], ids]);
    const t0 = performance.now();
    await w.sql(st, { maxRows: 1, repeat: 10 });
    res[k].push((performance.now() - t0) / 160);
  }
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const k of Object.keys(shapes))
  console.log(k.padEnd(8), "median ms per 64-body batch", med(res[k]).toFixed(3));
