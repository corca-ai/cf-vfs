import { lab } from "../../sql-lab/lab.mjs";

const w = lab("pipes");
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
const W = `WITH wanted(id) AS (VALUES ${ids.map(() => "(?)").join(",")})`;
const F = `FROM wanted CROSS JOIN vfs_inline_chunks c ON c.entry_id = wanted.id`;
const v = {
  empty: [],
  "blob rows (prod)": [[`${W} SELECT c.entry_id, c.chunk_index, c.body ${F}`, ids]],
  "text rows +ids": [
    [`${W} SELECT c.entry_id, c.chunk_index, CAST(c.body AS TEXT) AS b ${F}`, ids],
  ],
  "text rows +ids+len": [
    [
      `${W} SELECT c.entry_id, c.chunk_index, length(c.body) AS n, CAST(c.body AS TEXT) AS b ${F}`,
      ids,
    ],
  ],
  "one blob + json": [
    [
      `${W} SELECT CAST(group_concat(c.body, '' ORDER BY c.entry_id, c.chunk_index) AS BLOB) AS b, json_group_array(json_array(c.entry_id, c.chunk_index, length(c.body)) ORDER BY c.entry_id, c.chunk_index) AS m ${F}`,
      ids,
    ],
  ],
  "lengths only": [[`${W} SELECT length(c.body) AS n ${F}`, ids]],
};
const t = {};
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (let r = 0; r < 9; r++) {
  const keys = Object.keys(v);
  if (r % 2) keys.reverse();
  for (const k of keys) {
    const a = performance.now();
    await w.sql(v[k], { repeat: k === "empty" ? 1 : 50, maxRows: 1 });
    t[k] ??= [];
    t[k].push(performance.now() - a);
  }
}
const e = med(t.empty);
for (const [k, s] of Object.entries(t))
  console.log(
    k.padEnd(20),
    med(s).toFixed(1),
    "ms",
    k === "empty" ? "" : `${((med(s) - e) / 50).toFixed(3)} ms/batch`,
  );
