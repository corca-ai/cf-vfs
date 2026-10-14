import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { comparePoints, estimateWorkloads } from "../../demo/public/benchmarks/paired.js";
import { summaryMetrics } from "../../demo/public/benchmarks/summary.js";

const root = "bench/read-adoption-2026-10-14";
const plan = JSON.parse(await readFile(`${root}/plan.json`, "utf8"));
const runtime = JSON.parse(await readFile(`${root}/deployment.json`, "utf8"));
const acceptance = JSON.parse(await readFile(`${root}/acceptance.json`, "utf8"));
const sameStage = (a, b) =>
  ["group", "operation", "files", "cache"].every((key) => a[key] === b[key]);
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
for (const kind of process.argv.includes("--full-only") ? ["full"] : ["full", "task"]) {
  const baselineCount = kind === "task" ? plan.baselineTaskRuns : plan.baselineFullRuns;
  const baselinePrefix = kind === "task" ? plan.baselineTaskPrefix : plan.baselineFullPrefix;
  const baseline = await Promise.all(
    Array.from({ length: baselineCount }, (_, i) => read(`${baselinePrefix}${i + 1}.json`)),
  );
  const baselinePoint = point(baseline, plan.baselineCommit);
  const count = kind === "task" ? plan.taskRuns : plan.fullRuns;
  const current = await Promise.all(
    Array.from({ length: count }, (_, i) => read(`${root}/public-${kind}-${i + 1}.json`)),
  );
  for (const s of baseline) {
    assert.equal(result(s).commitHash, baselinePoint.commitHash);
    assert.equal(result(s).buildId, plan.baselineBuild);
  }
  for (const s of current) {
    assert.equal(result(s).buildId, runtime.build);
    assert.equal(result(s).commitHash, runtime.commit);
    assert.equal(result(s).deploymentId, runtime.deployment);
    assert.equal(result(s).rows.length, kind === "task" ? 1 : 190);
    assert.equal(result(s).verified, kind === "task" ? 28028 : 212268);
  }
  const candidate = point(current, runtime.commit);
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
  const confirmation = count > 3 ? { ...candidate, runs: candidate.runs.slice(3) } : null;
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
    note: "Public post-deployment verification, all five full and three task runs preselected and retained. Same public Worker/DO identities as baseline; private data not pooled. Four accepted signals remain explicit.",
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
  const median = (values) => {
    if (!values.length) return null;
    const sorted = values.toSorted((a, b) => a - b),
      i = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
  };
  const rpcControls = Object.fromEntries(
    [
      ["baseline", baseline],
      ["candidate", current],
    ].map(([label, snapshots]) => [
      label,
      snapshots.map((snapshot) => ({
        runId: result(snapshot).runId,
        edgeColo: result(snapshot).colo,
        note: "Edge colo is not DO or runner placement; pings are diagnostics and never subtracted.",
        ...Object.fromEntries(
          ["reference", "candidate"].map((arm) => {
            const values = (result(snapshot).diagnostics ?? [])
              .filter((d) => d.pair >= 0)
              .flatMap((d) => d[arm + "PingMs"] ?? []);
            return [arm, { samples: values.length, medianMs: median(values) }];
          }),
        ),
      })),
    ]),
  );
  const previousConfirmed = comparisons.filter(
    (r) => r.previous?.value > 105 && r.previous.ci95?.[0] > 100,
  );
  const unaccepted = previousConfirmed.filter(
    (r) => !acceptance.acceptedSignals.some((accepted) => sameStage(accepted.stage, r.row)),
  );
  const materiallyWorseAccepted = previousConfirmed.filter((r) => {
    const accepted = acceptance.acceptedSignals.find((a) => sameStage(a.stage, r.row));
    return accepted && r.previous.ci95[0] > accepted.previous.ci95[1];
  });
  const costReview =
    kind === "task"
      ? current.map((snapshot) => {
          const r = result(snapshot);
          return {
            runId: r.runId,
            pairs: r.rows[0].costs.candidate.map((cost, index) => ({
              reference: r.rows[0].costs.reference[index],
              candidate: cost,
              increases: Object.keys(cost).filter(
                (key) => cost[key] > r.rows[0].costs.reference[index][key],
              ),
            })),
          };
        })
      : null;
  const report = {
    runtime,
    acceptedSignals: acceptance.acceptedSignals.map((a) => a.stage),
    rpcControls,
    taskCosts,
    costReview,
    metrics,
    allWorkloads,
    flags,
    confirmed,
    previousConfirmed,
    unaccepted,
    materiallyWorseAccepted,
    rows: comparisons,
    baselineRuns: baselinePoint.sourceRuns,
    candidateRuns: candidate.sourceRuns,
    completeRunCounts: { baseline: baselinePoint.runs.length, candidate: candidate.runs.length },
    note: "Per-workload intervals are exploratory across 190 comparisons; investigate all signals with raw initial/confirmation/absolute and RPC evidence. Acceptance does not waive correctness, costs or new/materially worse regressions.",
  };
  await writeFile(
    `${root}/public-${kind}-comparison.json`,
    JSON.stringify(combined, null, 2) + "\n",
  );
  await writeFile(`${root}/public-${kind}-assessment.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        kind,
        metrics,
        allWorkloads,
        flags: flags.length,
        confirmed: confirmed.length,
        unaccepted: unaccepted.length,
        materiallyWorseAccepted: materiallyWorseAccepted.length,
        costIncreases:
          costReview?.flatMap((r) => r.pairs).filter((p) => p.increases.length).length ?? null,
      },
      null,
      2,
    ),
  );
}
