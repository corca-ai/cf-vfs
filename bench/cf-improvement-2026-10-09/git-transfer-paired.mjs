import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";
import { runTrial } from "./git-transfer.mjs";

const [beforePath, afterPath, output] = process.argv.slice(2);
const roots = {
  baseline: pathToFileURL(`${resolve(beforePath)}/`),
  candidate: pathToFileURL(`${resolve(afterPath)}/`),
};
const fingerprints = {};
for (const [version, root] of Object.entries(roots)) {
  const hash = createHash("sha256");
  for (const path of ["shell/commands/git-fs.js", "shell/commands/git-local.js"])
    hash.update(await readFile(new URL(path, root)));
  fingerprints[version] = hash.digest("hex");
}
const rows = [];
for (let trial = -3; trial < 10; trial++) {
  for (const version of pairOrder(trial)) {
    for (const row of await runTrial(roots[version], trial)) rows.push({ version, ...row });
  }
  console.log(`Completed pair ${trial + 4}/13`);
}
const summary = [];
for (const operation of [...new Set(rows.map((row) => row.operation))]) {
  const baseline = rows.filter((row) => row.version === "baseline" && row.operation === operation);
  const candidate = rows.filter(
    (row) => row.version === "candidate" && row.operation === operation,
  );
  assert.equal(baseline.length, 10);
  assert.equal(candidate.length, 10);
  summary.push({
    operation,
    baseline: distribution(baseline.map((row) => row.ms)),
    candidate: distribution(candidate.map((row) => row.ms)),
    ratio: pairedRatio(
      baseline.map((row) => row.ms),
      candidate.map((row) => row.ms),
    ),
    baselineCalls: baseline[0].calls,
    candidateCalls: candidate[0].calls,
  });
}
await writeFile(
  output,
  JSON.stringify(
    { node: process.version, fingerprints, warmupPairs: 3, measuredPairs: 10, rows, summary },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary, null, 2));
