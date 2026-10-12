import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { assessPairedSnapshot } from "./paired-assessment.mjs";

const [input, output] = process.argv.slice(2);
if (!input) throw new Error("Usage: bench:assess:paired SNAPSHOT.json [REPORT.json]");
const bytes = await readFile(input);
const saved = JSON.parse(input.endsWith(".gz") ? gunzipSync(bytes) : bytes);
const report = assessPairedSnapshot(saved);
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      conclusion: report.conclusion,
      metrics: report.metrics,
      regressions: report.regressions.length,
      review: report.review.length,
      unresolved: report.unresolved.length,
    },
    null,
    2,
  ),
);
if (report.requiresReview) process.exitCode = 2;
