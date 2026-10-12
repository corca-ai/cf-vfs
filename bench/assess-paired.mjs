import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  comparablePoints,
  comparePoints,
  estimateWorkloads,
} from "../demo/public/benchmarks/paired.js";
import { summaryMetrics } from "../demo/public/benchmarks/summary.js";

const [input, output] = process.argv.slice(2);
if (!input) throw new Error("Usage: bench:assess:paired SNAPSHOT.json [REPORT.json]");
const bytes = await readFile(input);
const saved = JSON.parse(input.endsWith(".gz") ? gunzipSync(bytes) : bytes);
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
  unresolved: rows.filter((r) => !r.reference),
  rows,
};
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      conclusion: report.conclusion,
      metrics,
      regressions: report.regressions.length,
      unresolved: report.unresolved.length,
    },
    null,
    2,
  ),
);
if (report.conclusion !== "faster" || report.regressions.length || report.unresolved.length)
  process.exitCode = 2;
