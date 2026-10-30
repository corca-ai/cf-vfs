import { writeFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node distinct-lookups-2026-10-30.mjs ROOT LAB
//
// Whether per-page cost on Cloudflare comes from statements or from touching
// many distinct rows: stat's own statement over 10,000 distinct paths (64 per
// request, one statement each), the same requests repeated so their pages are
// warm, and the filesystem's stat over the same paths.

const [root, name] = process.argv.slice(2);
const { ENTRY_JSON } = await import(`${root}/dist/vfs/sql-schema.js`);
const w = lab(name);
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
const sql = `SELECT ${ENTRY_JSON} AS entry FROM vfs_entries e INDEXED BY vfs_entries_path WHERE e.path = ?`;
const pings = [];
for (let i = 0; i < 5; i += 1) pings.push((await w.sql([], {})).ms);
const ping = [...pings].sort((a, b) => a - b)[2];
async function sweep(repeat) {
  let ms = 0;
  let requests = 0;
  for (let at = 0; at < paths.length; at += 64) {
    const batch = paths.slice(at, at + 64).map((path) => [sql, [path]]);
    ms += (await w.sql(batch, { repeat, maxRows: 1 })).ms;
    requests += 1;
  }
  return { ms, requests, perLookup: (ms - requests * ping) / (paths.length * repeat) };
}
const results = { ping, distinct: await sweep(1), warm: await sweep(10) };
const start = Date.now();
for (let at = 0; at < paths.length; at += 2000) await w.read(paths.slice(at, at + 2000), "stat");
results.fileSystemStat = {
  ms: Date.now() - start,
  perPage: (Date.now() - start - 5 * ping) / paths.length,
};
console.log(`ping ${ping} ms`);
console.log(
  `stat statement, distinct paths once:    ${results.distinct.perLookup.toFixed(4)} ms each (${results.distinct.requests} requests, ${results.distinct.ms} ms)`,
);
console.log(
  `stat statement, each request x10 (warm): ${results.warm.perLookup.toFixed(4)} ms each`,
);
console.log(
  `filesystem stat over the same paths:     ${results.fileSystemStat.perPage.toFixed(4)} ms each (${results.fileSystemStat.ms} ms)`,
);
writeFileSync(
  new URL("./distinct-lookups-2026-10-30.json", import.meta.url),
  `${JSON.stringify(results, null, 1)}\n`,
);
