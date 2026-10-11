import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { assessPairs } from "../../demo/public/benchmarks/summary.js";
import { comparePublicResults } from "../public-comparison.mjs";
import { readResult } from "./read-result.mjs";

const names = [
  "public-baseline",
  "public-candidate",
  "public-candidate-repeat",
  "public-baseline-fresh",
  "public-candidate-final",
];
const saved = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => {
      const { result } = await readResult(new URL(`${name}.json`, import.meta.url));
      assert.equal(result.rows.length, 190);
      assert.equal(result.verified, 60648);
      return [name, result];
    }),
  ),
);
const comparisons = [
  ["public-baseline", "public-candidate"],
  ["public-baseline", "public-candidate-repeat"],
  ["public-baseline", "public-baseline-fresh"],
  ["public-baseline-fresh", "public-candidate"],
  ["public-baseline-fresh", "public-candidate-repeat"],
  ["public-baseline-fresh", "public-candidate-final"],
].map(([before, after]) => ({
  before,
  after,
  ...assessPairs(comparePublicResults(saved[before], saved[after])),
}));
const result = {
  note: "Three-sample full public runs, descriptive screening only. Historical baseline, two candidate runs, fresh previous-version control, restored candidate. These time-adjacent controls do not replace the ten-pair private CF full plan or establish causal equivalence/noninferiority. Native SQL counters are absent from this public format and evaluated separately.",
  runs: Object.fromEntries(
    Object.entries(saved).map(([name, run]) => [
      name,
      {
        build: run.buildId,
        sourceCommit: run.commitHash,
        deployment: run.deploymentId,
        run: run.runId,
        completedAt: run.completedAt,
        verified: run.verified,
        rows: run.rows.length,
      },
    ]),
  ),
  comparisons,
};
await writeFile(
  new URL("public-followup.json", import.meta.url),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  comparisons.map(({ before, after, metrics, regressions, unresolved }) => ({
    before,
    after,
    metrics,
    regressions: regressions.length,
    unresolved: unresolved.length,
  })),
);
