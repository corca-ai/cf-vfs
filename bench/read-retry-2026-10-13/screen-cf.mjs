import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { estimateWorkloads } from "../../demo/public/benchmarks/paired.js";
import { summaryMetrics } from "../../demo/public/benchmarks/summary.js";

const [version, kind, countText] = process.argv.slice(2),
  count = Number(countText);
assert.ok(
  ["baseline", "candidate"].includes(version) &&
    ["full", "task"].includes(kind) &&
    Number.isInteger(count) &&
    count > 0 &&
    count <= 5,
);
const root = "bench/read-retry-2026-10-13";
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(gunzipSync(await readFile(path + ".gz")));
  }
}
const snapshots = await Promise.all(
  Array.from({ length: count }, (_, i) =>
    read(`${root}/cf-clean-${version}-${kind}-${i + 1}.json`),
  ),
);
for (const snapshot of snapshots) assert.equal(snapshot.status, "ready");
const runs = snapshots.map((s) => s.result),
  point = { ...runs[0], runs };
assert.equal(new Set(runs.map((r) => r.runId)).size, count);
for (const run of runs) {
  assert.deepEqual(run.protocol, point.protocol);
  assert.equal(run.buildId, point.buildId);
  assert.equal(run.rows.length, kind === "full" ? 190 : 1);
}
const metrics = (kind === "full" ? summaryMetrics : [{ id: "task", includes: () => true }]).map(
  (m) => ({ id: m.id, estimate: estimateWorkloads(point, point.rows.filter(m.includes)) }),
);
const report = {
  version,
  kind,
  runs: runs.map((r) => r.runId),
  metrics,
  note: "Interim descriptive screening. The preselected cohort and adoption gates are unchanged.",
};
await writeFile(
  `${root}/cf-clean-${version}-${kind}-${count}-screen.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
