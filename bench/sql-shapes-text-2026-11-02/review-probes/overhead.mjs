import { lab } from "../../sql-lab/lab.mjs";

const w = lab("pipes");
const ENTRY = "json_array(e.id, e.path, e.kind, e.size_bytes, e.mode, e.revision)";
const lookup = (tag) =>
  `/* ${tag} */ WITH requested(path) AS (VALUES ${Array.from({ length: 64 }, () => "(?)").join(",")}) SELECT ${ENTRY} AS entry FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path ON e.path = requested.path`;
const paths = (
  await w.sql([["SELECT path FROM vfs_entries WHERE kind = 'file' ORDER BY path LIMIT 64"]], {
    maxRows: 64,
  })
).results[0].rows.map((r) => r.path);
const nulls = paths.map(() => null);
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
let s = 0;
const run = Date.now().toString(36);
const v = {
  empty: () => [["SELECT 1"]],
  hit64rows: () => [[lookup("h"), paths]],
  hit0rows: () => [[lookup("h"), nulls]],
  miss64rows: () => [[lookup(`${run}-${s++}`), paths]],
  miss0rows: () => [[lookup(`${run}-${s++}`), nulls]],
};
for (const [label, f] of Object.entries(v)) {
  for (const rep of [1, 64]) {
    const t = [];
    for (let k = 0; k < 15; k++) {
      const st = Array.from({ length: rep }, () => f()[0]);
      const a = performance.now();
      const r = await w.sql(st, { maxRows: 1 });
      t.push([performance.now() - a, r.ms]);
    }
    console.log(
      label.padEnd(11),
      "stmts/request",
      rep,
      "client median ms",
      med(t.map((x) => x[0])).toFixed(2),
      "worker median ms",
      med(t.map((x) => x[1])),
    );
  }
}
