import { lab } from "./lab.mjs";

// Usage: node statement-cache-2026-11-02.mjs LAB
//
// Whether the runtime's prepared-statement cache holds the shapes a workload
// uses: 1,024 statements per round, the same 64-path entry lookup made
// distinct by a comment into 32 to 1,024 shapes, four rounds. A shape the
// cache no longer holds is prepared again in every round. Prints microseconds
// per statement, request overhead included. Meant for a local `cf dev` lab.
const [name] = process.argv.slice(2);
if (!name) throw new Error("usage: LAB");
const w = lab(name);
// Statement texts unique to this run, so no shape is cached beforehand.
const run = Date.now().toString(36);
const ENTRY = "json_array(e.id, e.path, e.kind, e.size_bytes, e.mode, e.revision)";
const lookup = (n, tag) =>
  `/* ${tag} */ WITH requested(path) AS (VALUES ${Array.from({ length: n }, () => "(?)").join(",")}) SELECT ${ENTRY} AS entry FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path ON e.path = requested.path`;
const paths = (
  await w.sql([["SELECT path FROM vfs_entries WHERE kind = 'file' ORDER BY path LIMIT 64"]], {
    maxRows: 64,
  })
).results[0].rows.map((r) => r.path);
for (const shapes of [32, 64, 128, 256, 512, 1024]) {
  const times = [];
  for (let round = 0; round < 4; round++) {
    let ms = 0;
    for (let batch = 0; batch < 16; batch++) {
      const statements = Array.from({ length: 64 }, (_, i) => [
        lookup(64, `${run}-${shapes}-${(batch * 64 + i) % shapes}`),
        paths,
      ]);
      const t = performance.now();
      await w.sql(statements, { maxRows: 1 });
      ms += performance.now() - t;
    }
    times.push(((ms / 1024) * 1000 * 512) / 1000);
  }
  console.log(
    `shapes ${String(shapes).padStart(4)}: ${times.map((v) => ((v / 512) * 1000).toFixed(1)).join(" ")} µs/statement`,
  );
}
