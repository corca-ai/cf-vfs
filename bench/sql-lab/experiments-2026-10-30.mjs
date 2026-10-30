import { readFileSync, writeFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node experiments-2026-10-30.mjs LAB [FIXTURE.json]
//
// Measures, in a SQL lab Durable Object holding the 10,000-page S3 wiki under
// /wiki, what reading and searching every page costs as SQL: the fixed cost
// of a statement, reading through the filesystem one page at a time (what
// grep -r and awiki do now), reading every body in one range scan or in
// batches, matching inside SQLite with instr and LIKE, and an FTS5 index.
// Pass FIXTURE to seed the lab first.

const [name, fixture] = process.argv.slice(2);
const w = lab(name);
if (fixture !== undefined) {
  const { files } = JSON.parse(readFileSync(fixture, "utf8"));
  await w.seed(Object.fromEntries(Object.entries(files).map(([path, c]) => [`wiki/${path}`, c])));
}

const results = {};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function timed(label, statements, options = {}, runs = 3) {
  const samples = [];
  let last;
  for (let run = 0; run < runs; run += 1) {
    last = await w.sql(statements, options);
    samples.push(last.ms);
  }
  const row = { ms: median(samples), samples, repeat: last.repeat, results: last.results };
  results[label] = row;
  const counts = last.results.map((r) => `${r.rowCount} rows, read ${r.rowsRead}`).join("; ");
  console.log(
    `${label.padEnd(44)} ${String(row.ms).padStart(6)} ms  [${samples.join(", ")}]  ${counts}`,
  );
  return row;
}

const RANGE = "e.path >= '/wiki/' AND e.path < '/wiki0' AND e.kind = 'file'";
const BODIES = `FROM vfs_entries e JOIN vfs_inline_chunks c ON c.entry_id = e.id WHERE ${RANGE}`;

const ping = await timed("empty request (RPC and Worker)", [], {}, 5);
const select = await timed("SELECT 1 x 1,000", [["SELECT 1"]], { repeat: 1000 });
const lookup = await timed(
  "path lookup x 1,000",
  [
    [
      "SELECT id FROM vfs_entries INDEXED BY vfs_entries_path WHERE path = ?",
      ["/wiki/eng/note-0101.md"],
    ],
  ],
  { repeat: 1000 },
);
console.log(
  `  per statement: SELECT 1 ${((select.ms - ping.ms) / 1000).toFixed(3)} ms, lookup ${((lookup.ms - ping.ms) / 1000).toFixed(3)} ms`,
);

const pathsResult = await w.sql(
  [[`SELECT e.path FROM vfs_entries e WHERE ${RANGE} ORDER BY e.path`]],
  {
    maxRows: 1000,
  },
);
const total = pathsResult.results[0].rowCount;
const all = [];
for (let offset = 0; offset < total; offset += 1000) {
  const page = await w.sql(
    [
      [
        `SELECT e.path FROM vfs_entries e WHERE ${RANGE} ORDER BY e.path LIMIT 1000 OFFSET ${offset}`,
      ],
    ],
    { maxRows: 1000 },
  );
  all.push(...page.results[0].rows.map((row) => row.path));
}
{
  const start = Date.now();
  let bytes = 0;
  for (let at = 0; at < all.length; at += 2000)
    bytes += (await w.read(all.slice(at, at + 2000))).bytes;
  results["readFile per page"] = { ms: Date.now() - start, bytes, pages: all.length };
  console.log(
    `${"readFile per page (5 requests)".padEnd(44)} ${String(Date.now() - start).padStart(6)} ms  ${bytes} bytes, ${all.length} pages`,
  );
}

await timed("every body, one range scan", [[`SELECT e.path, c.chunk_index, c.body ${BODIES}`]], {
  maxRows: 1,
});
// Durable Object SQLite binds at most 100 parameters, so batches are 64 paths, as statMany uses.
const batch = all.slice(0, 64);
const values = batch.map(() => "(?)").join(",");
const batched = await timed(
  "64 bodies by path, one statement x 10",
  [
    [
      `WITH requested(path) AS (VALUES ${values})
       SELECT e.path, c.body FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path
         ON e.path = requested.path JOIN vfs_inline_chunks c ON c.entry_id = e.id`,
      batch,
    ],
  ],
  { repeat: 10, maxRows: 1 },
);
console.log(
  `  10,000 bodies in 64-path batches: about ${Math.round(((batched.ms - ping.ms) / 10) * (all.length / 64))} ms`,
);

await timed("instr: pages linking note-0001", [
  [
    `SELECT count(DISTINCT e.path) AS n ${BODIES} AND instr(c.body, CAST(? AS BLOB)) > 0`,
    ["[[note-0001"],
  ],
]);
await timed("instr: pages with an owner line", [
  [
    `SELECT count(DISTINCT e.path) AS n ${BODIES} AND instr(c.body, CAST(? AS BLOB)) > 0`,
    ["\nowner:"],
  ],
]);
await timed("LIKE: pages linking note-0001", [
  [
    `SELECT count(DISTINCT e.path) AS n ${BODIES} AND CAST(c.body AS TEXT) LIKE ?`,
    ["%[[note-0001%"],
  ],
]);

let fts = true;
try {
  await timed(
    "FTS5: build index over every body",
    [
      ["DROP TABLE IF EXISTS lab_fts"],
      ["CREATE VIRTUAL TABLE lab_fts USING fts5(path UNINDEXED, body)"],
      [`INSERT INTO lab_fts(path, body) SELECT e.path, CAST(c.body AS TEXT) ${BODIES}`],
    ],
    {},
    1,
  );
} catch (error) {
  fts = false;
  console.log(`FTS5 unavailable: ${error.message}`);
}
if (fts) {
  await timed(
    "FTS5: pages matching note 0001 x 100",
    [["SELECT count(*) AS n FROM lab_fts WHERE lab_fts MATCH ?", ['"note 0001"']]],
    { repeat: 100 },
  );
  await timed("FTS5: index size", [
    ["SELECT count(*) AS pages, sum(length(block)) AS bytes FROM lab_fts_data"],
  ]);
}

writeFileSync(
  new URL(`./experiments-2026-10-30-${name}.json`, import.meta.url),
  `${JSON.stringify(results, null, 1)}\n`,
);
