import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { comparePoints, estimateWorkloads } from "../../demo/public/benchmarks/paired.js";
import { summaryMetrics } from "../../demo/public/benchmarks/summary.js";

const root = "bench/read-retry-2026-10-13";
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return JSON.parse(gunzipSync(await readFile(path + ".gz")));
  }
}
const result = (s) => s.result ?? s;
function point(snapshots, label) {
  const results = snapshots.map(result),
    last = results.at(-1);
  for (const r of results) {
    assert.deepEqual(r.protocol, last.protocol);
    assert.equal(r.engine, last.engine);
    assert.equal(r.measurement, last.measurement);
    assert.deepEqual(
      r.rows.map((r) => [r.group, r.operation, r.files, r.cache, r.iterations]),
      last.rows.map((r) => [r.group, r.operation, r.files, r.cache, r.iterations]),
    );
  }
  return {
    ...last,
    commitHash: label,
    runs: results.map((r) => ({
      runId: r.runId,
      completedAt: r.completedAt,
      buildId: r.buildId,
      deploymentId: r.deploymentId,
      rows: r.rows,
    })),
    sourceRuns: results.map((r) => ({
      runId: r.runId,
      commitHash: r.commitHash,
      buildId: r.buildId,
    })),
  };
}
for (const kind of ["full", "task"]) {
  const old = await Promise.all(
    [1, 2, 3].map((i) =>
      read("bench/agent-task-2026-10-12/cf-" + kind + "-baseline-" + i + ".json"),
    ),
  );
  const baseline =
    kind === "full" ? [...old, await read(root + "/cf-baseline-full-diagnostic.json")] : old;
  const baselinePoint = point(baseline, "equivalent-library-baseline-9b35638-and-2700b6d"),
    historical = point(old, "9b35638");
  const count = kind === "full" ? 5 : 3;
  const current = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      read(root + "/cf-verified-" + kind + "-" + (i + 1) + ".json"),
    ),
  );
  const candidate = point(current, result(current.at(-1)).commitHash);
  assert.equal(candidate.commitHash, "4104095be55705f4e9137b952640dc060afa9812");
  assert.equal(candidate.runs.length, count);
  assert.deepEqual(candidate.protocol, baselinePoint.protocol);
  const rows = result(current.at(-1)).rows;
  const metrics = (kind === "full" ? summaryMetrics : [{ id: "task", includes: () => true }]).map(
    (m) => {
      const selected = rows.filter(m.includes);
      return {
        id: m.id,
        workloads: selected.length,
        reference: estimateWorkloads(candidate, selected),
        previous: comparePoints(baselinePoint, candidate, selected),
        historicalSensitivity: comparePoints(historical, candidate, selected),
      };
    },
  );
  const confirmation = kind === "full" ? { ...candidate, runs: candidate.runs.slice(3) } : null;
  const comparisons = rows.map((row) => ({
    row,
    reference: estimateWorkloads(candidate, [row]),
    previous: comparePoints(baselinePoint, candidate, [row]),
    confirmationReference: confirmation ? estimateWorkloads(confirmation, [row]) : null,
  }));
  const flags = comparisons.filter((r) => r.reference?.value > 105 || r.previous?.value > 105);
  const confirmed = flags.filter((r) =>
    [r.reference, r.previous].some((e) => e?.value > 105 && e.ci95?.[0] > 100),
  );
  const combined = {
    ...current.at(-1),
    history: [baselinePoint, candidate],
    note: "Offline analysis only: equivalent baseline pools three unchanged-runtime historical sessions plus the new complete A/A session. This does not overwrite public commit history. Two failed new baseline attempts remain separately archived.",
    provenance: { baseline: baselinePoint.sourceRuns, candidate: candidate.sourceRuns },
  };
  const allWorkloads = {
    reference: estimateWorkloads(candidate, rows),
    previous: comparePoints(baselinePoint, candidate, rows),
  };
  const report = {
    metrics,
    allWorkloads,
    flags,
    confirmed,
    rows: comparisons,
    baselineRuns: baselinePoint.sourceRuns,
    candidateRuns: candidate.sourceRuns,
    completeRunCounts: { baseline: baselinePoint.runs.length, candidate: candidate.runs.length },
  };
  await writeFile(
    root + "/cf-verified-" + kind + "-comparison.json",
    JSON.stringify(combined, null, 2) + "\n",
  );
  await writeFile(
    root + "/cf-verified-" + kind + "-assessment.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      { kind, metrics, allWorkloads, flags: flags.length, confirmed: confirmed.length },
      null,
      2,
    ),
  );
}
