import { writeFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node read-path-2026-10-30.mjs LAB
//
// Splits the cost of reading 10,000 pages through the filesystem: stat only,
// readFile then cancel, readFile and consume the stream, against fetching one
// body per SQL statement.

const w = lab(process.argv[2]);
const RANGE = "e.path >= '/wiki/' AND e.path < '/wiki0' AND e.kind = 'file'";
const paths = [];
for (let offset = 0; ; offset += 1000) {
  const page = await w.sql(
    [
      [
        `SELECT e.path FROM vfs_entries e WHERE ${RANGE} ORDER BY e.path LIMIT 1000 OFFSET ${offset}`,
      ],
    ],
    { maxRows: 1000 },
  );
  if (page.results[0].rowCount === 0) break;
  paths.push(...page.results[0].rows.map((row) => row.path));
}
const results = {};
for (const mode of ["stat", "cancel", "stream", "stat", "cancel", "stream"]) {
  const start = Date.now();
  for (let at = 0; at < paths.length; at += 2000) await w.read(paths.slice(at, at + 2000), mode);
  const ms = Date.now() - start;
  results[mode] = [...(results[mode] ?? []), ms];
  console.log(
    `${mode.padEnd(8)} ${paths.length} pages in 5 requests: ${ms} ms (${(ms / paths.length).toFixed(3)} ms/page)`,
  );
}
const one = await w.sql(
  [
    [
      "SELECT c.body FROM vfs_entries e INDEXED BY vfs_entries_path JOIN vfs_inline_chunks c ON c.entry_id = e.id WHERE e.path = ?",
      [paths[0]],
    ],
  ],
  { repeat: 1000, maxRows: 1 },
);
results.sqlBodyPerStatement = one.ms;
console.log(
  `one body per SQL statement x 1,000: ${one.ms} ms (${(one.ms / 1000).toFixed(3)} ms each)`,
);
writeFileSync(
  new URL("./read-path-2026-10-30.json", import.meta.url),
  `${JSON.stringify(results, null, 1)}\n`,
);
