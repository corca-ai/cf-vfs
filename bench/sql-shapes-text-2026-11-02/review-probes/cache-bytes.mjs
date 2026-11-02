import { lab } from "../../sql-lab/lab.mjs";

// Is the statement cache bounded by count or by SQL-text bytes?
// For pad P bytes of comment and N shapes: 1024 statements/round cycling N texts,
// 4 rounds; plus controls in the same run: hit (1 shape) and miss (new text each).
const w = lab("pipes");
const run = Date.now().toString(36);
const ENTRY = "json_array(e.id, e.path, e.kind, e.size_bytes, e.mode, e.revision)";
const lookup = (tag, pad) =>
  `/* ${tag} ${"x".repeat(pad)} */ WITH requested(path) AS (VALUES ${Array.from({ length: 64 }, () => "(?)").join(",")}) SELECT ${ENTRY} AS entry FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path ON e.path = requested.path`;
const paths = (
  await w.sql([["SELECT path FROM vfs_entries WHERE kind = 'file' ORDER BY path LIMIT 64"]], {
    maxRows: 64,
  })
).results[0].rows.map((r) => r.path);
const pad = Number(process.argv[2] ?? 8000);
const perReq = Math.max(1, Math.min(64, Math.floor(2_000_000 / (pad + 600))));
async function round(tagOf) {
  let ms = 0;
  for (let at = 0; at < 1024; at += perReq) {
    const n = Math.min(perReq, 1024 - at);
    const st = Array.from({ length: n }, (_, i) => [lookup(tagOf(at + i), pad), paths]);
    const t = performance.now();
    await w.sql(st, { maxRows: 1 });
    ms += performance.now() - t;
  }
  return (ms / 1024) * 1000;
}
let serial = 0;
const sizes = (process.argv[3] ?? "1,32,64,96,128,192,256,512").split(",").map(Number);
for (const shapes of sizes) {
  const r = [];
  for (let k = 0; k < 4; k++) r.push(await round((i) => `${run}-${pad}-${shapes}-${i % shapes}`));
  const miss = await round(() => `${run}-miss-${serial++}`);
  console.log(
    `pad ${pad} shapes ${String(shapes).padStart(4)} (~${Math.round((shapes * (pad + 520)) / 1024)} KiB text): ${r.map((v) => v.toFixed(1)).join(" ")} µs/stmt | all-miss control ${miss.toFixed(1)}`,
  );
}
