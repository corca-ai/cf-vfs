import { readFile, writeFile } from "node:fs/promises";
import { assessPairs } from "../demo/public/benchmarks/summary.js";
import { comparePublicResults } from "./public-comparison.mjs";

const [beforePath, afterPath, output] = process.argv.slice(2);
if (!beforePath || !afterPath)
  throw new Error("Usage: bench:assess -- BASELINE.json CANDIDATE.json [REPORT.json]");
const read = async (path) => {
  const saved = JSON.parse(await readFile(path, "utf8"));
  return saved.result ?? saved;
};
const [before, after] = await Promise.all([read(beforePath), read(afterPath)]);
const report = {
  baseline: before.commitHash ?? before.runId,
  candidate: after.commitHash ?? after.runId,
  note: "Descriptive screening; any >5% slowdown or unresolved zero needs investigation. Not statistical proof of improvement.",
  ...assessPairs(comparePublicResults(before, after)),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, text);
console.log(text);
if (report.requiresReview) process.exitCode = 2;
