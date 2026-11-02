import { lab } from "../../sql-lab/lab.mjs";

const w = lab(process.argv[2]);
const PADN = Number(process.argv[3] ?? 20000);
const REPEAT = 20;
const paths = Array.from({ length: 64 }, (_, i) => `/p/${String(i).padStart(3, "0")}.md`);
const ENTRY = "json_array(e.id, e.path, e.kind, e.size_bytes, e.mode, e.revision)";
const pad = "x".repeat(PADN);
const lookup = (tag) =>
  `/* ${tag} ${pad} */ WITH requested(path) AS (VALUES ${paths.map(() => "(?)").join(",")}) SELECT ${ENTRY} AS entry FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path ON e.path = requested.path`;
const configs = [64, 32, 16];
const res = Object.fromEntries(configs.map((c) => [c, []]));
for (let trial = 0; trial < 8; trial++) {
  for (const distinct of trial % 2 ? [...configs].reverse() : configs) {
    const tag = `${Date.now().toString(36)}-${trial}-${distinct}`;
    const st = Array.from({ length: 64 }, (_, i) => [lookup(`${tag}-${i % distinct}`), paths]);
    const t = performance.now();
    await w.sql(st, { maxRows: 1, repeat: REPEAT });
    res[distinct].push(((performance.now() - t) / (64 * REPEAT)) * 1000);
  }
}
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const c of configs)
  console.log(
    `pad ${PADN} distinct ${String(c).padStart(2)} (~${((lookup("x").length * c) / 1024).toFixed(0)} KiB): median ${med(res[c]).toFixed(1)} µs/stmt  [${res[c].map((v) => v.toFixed(0)).join(" ")}]`,
  );
