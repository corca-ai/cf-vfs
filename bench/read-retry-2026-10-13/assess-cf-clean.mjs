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
  for (const snapshot of snapshots) assert.equal(snapshot.status, "ready");
  const results = snapshots.map(result),
    last = results.at(-1);
  assert.equal(new Set(results.map((r) => r.runId)).size, results.length, "Runs must be distinct");
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
function absolutePoint(snapshots, label, arm) {
  return point(
    snapshots.map((snapshot) => ({
      ...snapshot,
      result: {
        ...snapshot.result,
        rows: snapshot.result.rows.map((row) => ({
          ...row,
          samplesMs: arm === "reference" ? row.referenceMs : row.samplesMs,
          referenceMs: row.samplesMs.map(() => 1),
        })),
      },
    })),
    label,
  );
}
for (const kind of ["full", "task"]) {
  const baseline = await Promise.all(
    Array.from({ length: kind === "task" ? 5 : 3 }, (_, i) =>
      read(`${root}/cf-clean-baseline-${kind}-${i + 1}.json`),
    ),
  );
  const baselinePoint = point(baseline, "2700b6da336d04b604238220b900c0433a822298");
  const count = 5;
  const current = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      read(`${root}/cf-clean-candidate-${kind}-${i + 1}.json`),
    ),
  );
  for (const s of baseline) {
    assert.equal(result(s).commitHash, baselinePoint.commitHash);
    assert.equal(
      result(s).buildId,
      "6202f9e15d94839fc9e38617cad41db18a0aec1f54d93914e5572f539d2c0607",
    );
  }
  for (const s of current)
    assert.equal(
      result(s).buildId,
      "95ea59dd1e5f8dcb3885c1d1870295ed5977a4f9c0ca5162f5b89056049b7763",
    );
  const candidate = point(current, result(current.at(-1)).commitHash);
  assert.equal(candidate.commitHash, "4104095be55705f4e9137b952640dc060afa9812");
  assert.equal(candidate.runs.length, count);
  assert.deepEqual(candidate.protocol, baselinePoint.protocol);
  const rows = result(current.at(-1)).rows;
  const absoluteControls = Object.fromEntries(
    ["reference", "candidate"].map((arm) => [
      arm,
      {
        baseline: absolutePoint(baseline, baselinePoint.commitHash, arm),
        candidate: absolutePoint(current, candidate.commitHash, arm),
      },
    ]),
  );
  const metrics = (kind === "full" ? summaryMetrics : [{ id: "task", includes: () => true }]).map(
    (m) => {
      const selected = rows.filter(m.includes);
      return {
        id: m.id,
        workloads: selected.length,
        baselineReference: estimateWorkloads(baselinePoint, selected),
        reference: estimateWorkloads(candidate, selected),
        previous: comparePoints(baselinePoint, candidate, selected),
        absolutePrevious: Object.fromEntries(
          Object.entries(absoluteControls).map(([arm, points]) => [
            arm,
            comparePoints(points.baseline, points.candidate, selected),
          ]),
        ),
      };
    },
  );
  const confirmation = { ...candidate, runs: candidate.runs.slice(3) };
  const initial = { ...candidate, runs: candidate.runs.slice(0, 3) };
  const comparisons = rows.map((row) => ({
    row,
    baselineReference: estimateWorkloads(baselinePoint, [row]),
    reference: estimateWorkloads(candidate, [row]),
    previous: comparePoints(baselinePoint, candidate, [row]),
    initialReference: estimateWorkloads(initial, [row]),
    initialPrevious: comparePoints(baselinePoint, initial, [row]),
    confirmationReference: confirmation ? estimateWorkloads(confirmation, [row]) : null,
    confirmationPrevious: confirmation ? comparePoints(baselinePoint, confirmation, [row]) : null,
    perRunReference: candidate.runs.map((run) =>
      estimateWorkloads({ ...candidate, runs: [run] }, [row]),
    ),
  }));
  const flags = comparisons.filter((r) =>
    [r.reference, r.previous, r.initialReference, r.initialPrevious, ...r.perRunReference].some(
      (e) => e?.value > 105,
    ),
  );
  const confirmed = flags.filter((r) =>
    [r.reference, r.previous].some((e) => e?.value > 105 && e.ci95?.[0] > 100),
  );
  const combined = {
    ...current.at(-1),
    history: [baselinePoint, candidate],
    note: "Offline analysis only: fresh preselected cohort without live tail. Three baseline full runs, five candidate full runs and five task runs per version. Excluded logging cohorts remain archived separately.",
    provenance: { baseline: baselinePoint.sourceRuns, candidate: candidate.sourceRuns },
  };
  const allWorkloads = {
    reference: estimateWorkloads(candidate, rows),
    previous: comparePoints(baselinePoint, candidate, rows),
  };
  const taskCosts =
    kind === "task"
      ? ["baseline", "candidate"].map((name, index) => ({
          version: name,
          runs: (index === 0 ? baseline : current).map((snapshot) => {
            const row = result(snapshot).rows[0];
            assert.equal(row.costs.reference.length, 6);
            assert.equal(row.costs.candidate.length, 6);
            return { runId: result(snapshot).runId, costs: row.costs };
          }),
        }))
      : null;
  const report = {
    taskCosts,
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
    root + "/cf-clean-" + kind + "-comparison.json",
    JSON.stringify(combined, null, 2) + "\n",
  );
  await writeFile(
    root + "/cf-clean-" + kind + "-assessment.json",
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
