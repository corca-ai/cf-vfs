import { readFileSync } from "node:fs";

// Usage: node bench/summarize-local-pairs.mjs SESSION.json...
//
// Equal-weight summary of local-group-v1 sessions: per workload the geometric
// mean of candidate/baseline over every timed pair of every session (each
// session weighted equally), families by group, the overall geometric mean,
// workloads slower by more than 5%, and SQL statement/row differences from the
// separate replay. Nothing is trimmed; a zero timing leaves its workload
// unresolved.

const gm = (values) => Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);
const key = (stage) =>
  `${stage.group}/${stage.operation}/${stage.files}${stage.cache ? "/cache" : ""}/${stage.trial ?? 0}`;
const sessions = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, "utf8")));
const perWorkload = new Map();
const unresolved = new Set();
const sql = new Map();
for (const session of sessions) {
  if (!session.complete) throw new Error("incomplete session");
  const pairs = new Map();
  for (const row of session.rows) {
    const id = key(row.stage);
    if (row.profile) {
      const s = sql.get(id) ?? { baseline: [0, 0], candidate: [0, 0] };
      s[row.version][0] += row.statements;
      s[row.version][1] += row.returnedRows;
      sql.set(id, s);
      continue;
    }
    const pair = pairs.get(`${id}#${row.pair}`) ?? { id };
    pair[row.version] = row.ms;
    pairs.set(`${id}#${row.pair}`, pair);
  }
  const ratios = new Map();
  for (const pair of pairs.values()) {
    if (!(pair.baseline > 0 && pair.candidate > 0)) {
      unresolved.add(pair.id);
      continue;
    }
    ratios.set(pair.id, [...(ratios.get(pair.id) ?? []), pair.candidate / pair.baseline]);
  }
  for (const [id, values] of ratios)
    perWorkload.set(id, [...(perWorkload.get(id) ?? []), gm(values)]);
}
const workloads = [...perWorkload]
  .filter(([id]) => !unresolved.has(id))
  .map(([id, v]) => [id, gm(v)]);
const families = new Map();
for (const [id, ratio] of workloads) {
  const family = id.split("/")[0];
  families.set(family, [...(families.get(family) ?? []), ratio]);
}
console.log(
  `sessions ${sessions.length}, workloads ${workloads.length}, unresolved ${unresolved.size}`,
);
console.log(`overall ${gm(workloads.map(([, r]) => r)).toFixed(3)}`);
for (const [family, ratios] of [...families].sort())
  console.log(`  ${family.padEnd(22)} ${gm(ratios).toFixed(3)} (${ratios.length})`);
const slower = workloads.filter(([, r]) => r > 1.05).sort((a, b) => b[1] - a[1]);
console.log(`>5% slower: ${slower.length}`);
for (const [id, r] of slower)
  console.log(
    `  ${id} ${r.toFixed(3)} [${perWorkload
      .get(id)
      .map((v) => v.toFixed(2))
      .join(", ")}]`,
  );
const faster = workloads
  .filter(([, r]) => r < 0.95)
  .sort((a, b) => a[1] - b[1])
  .slice(0, 12);
console.log(`>5% faster (top 12):`);
for (const [id, r] of faster) console.log(`  ${id} ${r.toFixed(3)}`);
const totals = { baseline: [0, 0], candidate: [0, 0] };
const sqlDiffs = [];
for (const [id, s] of sql) {
  for (const v of ["baseline", "candidate"]) for (const i of [0, 1]) totals[v][i] += s[v][i];
  if (s.baseline[0] !== s.candidate[0] || s.baseline[1] !== s.candidate[1]) sqlDiffs.push([id, s]);
}
console.log(
  `SQL statements ${totals.baseline[0]} -> ${totals.candidate[0]}, rows read ${totals.baseline[1]} -> ${totals.candidate[1]}`,
);
console.log(`workloads with SQL differences: ${sqlDiffs.length}`);
for (const [id, s] of sqlDiffs.slice(0, 20))
  console.log(
    `  ${id} statements ${s.baseline[0]} -> ${s.candidate[0]}, rows ${s.baseline[1]} -> ${s.candidate[1]}`,
  );
