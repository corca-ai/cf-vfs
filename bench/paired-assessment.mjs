import {
  comparablePoints,
  comparePoints,
  estimateWorkloads,
} from "../demo/public/benchmarks/paired.js";
import { summaryMetrics } from "../demo/public/benchmarks/summary.js";

/** Shared adoption policy for the CLI and deterministic tests. */
export function assessPairedSnapshot(saved) {
  const result = saved.result ?? saved;
  if (!result.protocol)
    throw new Error("A paired-protocol result is required; legacy timing is not comparable");
  const fallback = { ...result, runs: [{ runId: result.runId, rows: result.rows }] };
  const points = comparablePoints(saved.history ?? [fallback], result);
  const current = points.find((p) => p.commitHash === result.commitHash);
  if (!current) throw new Error("Missing current commit observations");
  const previous = points[points.indexOf(current) - 1];
  const metrics = summaryMetrics.map((m) => ({
    id: m.id,
    reference: estimateWorkloads(current, result.rows.filter(m.includes)),
    previous: previous ? comparePoints(previous, current, result.rows.filter(m.includes)) : null,
  }));
  const rows = result.rows.map((row) => ({
    group: row.group,
    operation: row.operation,
    files: row.files,
    cache: row.cache,
    reference: estimateWorkloads(current, [row]),
    previous: previous ? comparePoints(previous, current, [row]) : null,
  }));
  const primary = metrics.find((m) => m.id === "overall");
  const comparison = previous ? primary.previous : primary.reference;
  const report = {
    commit: result.commitHash,
    reference: result.protocol.referenceCommit,
    previous: previous?.commitHash ?? null,
    note: "Run-cluster intervals on paired log ratios. At least three retained runs per compared commit are required. Individual intervals are pointwise; SQL cost and compatibility gates remain separate. No zero replacement, trimming or best-run selection.",
    conclusion: !comparison ? "unresolved" : comparison.status,
    metrics,
    regressions: rows.filter((r) => {
      const v = previous ? r.previous : r.reference;
      return v?.value > 105 && v?.status === "slower";
    }),
    review: rows.filter((r) => (previous ? r.previous : r.reference)?.value > 105),
    unresolved: rows.filter((r) => !r.reference),
    rows,
  };
  return {
    ...report,
    requiresReview:
      report.conclusion !== "faster" || report.review.length > 0 || report.unresolved.length > 0,
  };
}
