import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { estimatePaired } from "../../demo/public/benchmarks/paired.js";
import { summaryMetrics, workloadKey } from "../../demo/public/benchmarks/summary.js";

const [input, output] = process.argv.slice(2);
const bytes = await readFile(input);
const raw = JSON.parse(input.endsWith(".gz") ? gunzipSync(bytes) : bytes);
if (raw.protocol?.id === "local-group-v1") assert.equal(raw.complete, true);
const indexed = new Map();
for (const row of raw.rows.filter((r) => !r.profile)) {
  const key = `${row.pair}:${workloadKey(row.stage)}:${row.version}`;
  assert.ok(!indexed.has(key), `Duplicate observation: ${key}`);
  indexed.set(key, row.ms);
}
function estimate(stages) {
  const logs = Array.from({ length: raw.trials }, (_, pair) => {
    const ratios = stages.map((stage) => {
      const key = `${pair}:${workloadKey(stage)}`;
      const before = indexed.get(`${key}:baseline`),
        after = indexed.get(`${key}:candidate`);
      return before > 0 && after > 0 ? Math.log(after / before) : Number.NaN;
    });
    return ratios.reduce((sum, x) => sum + x, 0) / ratios.length;
  });
  return {
    estimate: estimatePaired([logs]),
    // Diagnostic only: both orders remain in the primary equal-weight mean.
    orderIndices: [0, 1].map((order) => {
      const values = logs.filter((_, pair) => (pair + (raw.orderOffset ?? 0)) % 2 === order);
      return 100 * Math.exp(values.reduce((a, b) => a + b, 0) / values.length);
    }),
  };
}
const stages = raw.workloads.map((row) => row.stage);
const metrics = summaryMetrics
  .filter((metric) => stages.some(metric.includes))
  .map((metric) => ({
    id: metric.id,
    ...estimate(stages.filter(metric.includes)),
  }));
const workloads = stages.map((stage) => ({ stage, ...estimate([stage]) }));
const review = workloads.filter(
  (row) =>
    row.estimate === null ||
    row.estimate.value > 105 ||
    raw.regressions.some((old) => workloadKey(old.stage) === workloadKey(row.stage)),
);
const assessment = {
  input,
  measurementProtocol: raw.protocol ?? {
    id: "legacy-local-stage-v1",
    orderOffset: raw.orderOffset ?? 0,
  },
  protocol:
    "Equal workload weights and mean log paired ratios, matching paired production statistics. One local session: interval is within-run, not a production adoption decision. Legacy median-bootstrap flags also remain in review.",
  metrics,
  review,
  costRegressions: raw.costRegressions,
  workloads,
};
await writeFile(output, `${JSON.stringify(assessment, null, 2)}\n`);
console.log({ metrics, review: review.length, costRegressions: raw.costRegressions.length });
