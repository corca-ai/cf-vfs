import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// Derive the adoption summary from complete measurements, never checkpoints.
const results = [];
for (const credentials of ["demo", "none"]) {
  const name = `cf-combined-round11-${credentials}.json`;
  let bytes;
  try {
    bytes = await readFile(new URL(name, import.meta.url));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = gunzipSync(await readFile(new URL(`${name}.gz`, import.meta.url)));
  }
  const run = JSON.parse(bytes);
  assert.equal(run.credentials, credentials);
  assert.equal(run.fullPlan, true);
  assert.equal(run.trials, 10);
  assert.equal(run.workloads.length, 190);
  assert.ok(run.completedAt);
  assert.equal(run.metrics.find(({ id }) => id === "overall").workloads, 146);
  const costs = Object.fromEntries(
    ["baseline", "candidate"].map((version) => {
      const rows = run.rows.filter((row) => row.profile && row.version === version);
      assert.equal(rows.length, 190);
      return [
        version,
        {
          stages: rows.length,
          ...Object.fromEntries(
            ["statements", "rowsRead", "rowsWritten"].map((key) => [
              key,
              rows.reduce((sum, row) => sum + row.sql[key], 0),
            ]),
          ),
        },
      ];
    }),
  );
  const overall = run.metrics.find(({ id }) => id === "overall").ratio;
  results.push({
    credentials,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    candidate: run.candidate,
    fullPlan: run.fullPlan,
    trials: run.trials,
    metrics: run.metrics,
    primaryLatencyReductionPercent: 100 * (1 - overall.median),
    primaryReciprocalScoreIncreasePercent: 100 * (1 / overall.median - 1),
    pointwiseFlags: run.regressions.length,
    confirmedFlags: run.confirmed.map(({ stage, baseline, candidate, ratio }) => ({
      stage,
      baselineMedianMs: baseline.median,
      candidateMedianMs: candidate.median,
      ratio,
    })),
    costFlags: run.costRegressions.map(({ stage, costs }) => ({ stage, costs })),
    nativeSqlTotals: costs,
    colos: [...new Set(run.placements.map(({ colo }) => colo))],
  });
}
const output = {
  baseline: "accepted round two (d285026 implementation)",
  candidate: "final round eleven (append-cache-final immutable graph)",
  policy:
    "Primary outcome is the equal-workload geometric mean over all 146 uncached workloads. Cache variants are separate. Individual tradeoffs are disclosed under the user's aggregate-score policy. Native costs are separate from timing.",
  results,
};
await writeFile(
  new URL("cf-round11-summary.json", import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
