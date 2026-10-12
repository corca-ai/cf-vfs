import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { comparePoints, estimateWorkloads } from "../../demo/public/benchmarks/paired.js";
import { summaryMetrics } from "../../demo/public/benchmarks/summary.js";
import { assessPairedSnapshot } from "../paired-assessment.mjs";

const root = new URL("./", import.meta.url);
const label = process.argv[2] ?? "";
assert.match(label, /^[a-z0-9-]*$/u);
const prefix = label ? `cf-${label}-` : "cf-";
async function read(name) {
  try {
    return JSON.parse(await readFile(new URL(name, root), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(gunzipSync(await readFile(new URL(`${name}.gz`, root))));
  }
}
const before = await read("cf-full-baseline-3.json");
const after = await read(`${prefix}full-confirmation-2.json`);
const original = await read(`${prefix}full-assessment.json`);
const point = (snapshot) =>
  snapshot.history.find((p) => p.commitHash === snapshot.result.commitHash);
const baseline = point(before),
  candidate = point(after);
assert.equal(candidate.runs.length, 5);
assert.equal(baseline.runs.length, 3);
const selected = { ...candidate, runs: candidate.runs.slice(-2) };
const combined = { ...after, history: [baseline, candidate] };
const report = assessPairedSnapshot(combined);
const allWorkloads = {
  count: after.result.rows.length,
  note: "Additional diagnostic including the optional cache cohort; the existing VFS-only adoption metric is unchanged.",
  reference: estimateWorkloads(candidate, after.result.rows),
  previous: comparePoints(baseline, candidate, after.result.rows),
};
const confirmation = {
  note: "Two preselected complete confirmation runs: twelve new balanced pairs per workload. Intervals use two run clusters, not twelve independent sessions. All five runs remain in the combined assessment.",
  metrics: summaryMetrics.map((metric) => ({
    id: metric.id,
    reference: estimateWorkloads(selected, after.result.rows.filter(metric.includes)),
    previous: comparePoints(baseline, selected, after.result.rows.filter(metric.includes)),
  })),
  rows: after.result.rows.map((row) => ({
    row,
    reference: estimateWorkloads(selected, [row]),
    previous: comparePoints(baseline, selected, [row]),
  })),
};
const confirmed = confirmation.rows.filter(({ reference, previous }) =>
  [reference, previous].some((estimate) => estimate?.value > 105 && estimate.ci95?.[0] > 100),
);
await writeFile(
  new URL(`${prefix}full-five-run-comparison.json`, root),
  `${JSON.stringify(combined, null, 2)}\n`,
);
await writeFile(
  new URL(`${prefix}full-confirmed-assessment.json`, root),
  `${JSON.stringify({ original, confirmation, combined: report, allWorkloads, confirmed }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      metrics: report.metrics,
      allWorkloads,
      originalConclusion: original.conclusion,
      combinedConclusion: report.conclusion,
      review: report.review.length,
      confirmationFlags: confirmed,
    },
    null,
    2,
  ),
);
