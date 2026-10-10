import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [beforePath, afterPath, output] = process.argv.slice(2);
const versions = {};
const fingerprints = {};
for (const [name, path] of Object.entries({ baseline: beforePath, candidate: afterPath })) {
  const root = pathToFileURL(`${resolve(path)}/`);
  versions[name] = (await import(new URL("testing/node.js", root))).NodeSqlFileSystem;
  fingerprints[name] = createHash("sha256")
    .update(await readFile(new URL("vfs/sql-move-base.js", root)))
    .digest("hex");
}
const rows = [];
for (let trial = -3; trial < 10; trial++) {
  for (const version of pairOrder(trial)) {
    let calls = 0,
      returnedRows = 0;
    const fs = new versions[version]({
      onStatement: (_query, count) => {
        calls++;
        returnedRows += count;
      },
    });
    fs.mkdir("/repo");
    fs.mkdir("/objects");
    for (let offset = 0; offset < 5000; offset += 128) {
      await fs.writeFiles(
        Array.from({ length: Math.min(128, 5000 - offset) }, (_, i) => {
          const index = offset + i;
          return {
            path: index < 1000 ? `/repo/f${index}` : `/objects/f${index}`,
            body: `body ${index}`,
          };
        }),
      );
    }
    calls = 0;
    returnedRows = 0;
    const start = performance.now();
    for (let i = 0; i < 1000; i++) assert.equal((await fs.remove(`/repo/f${i}`)).removed, 1);
    const ms = performance.now() - start;
    if (trial >= 0) rows.push({ trial, version, ms, calls, returnedRows });
    assert.equal(fs.list("/repo").length, 0);
    assert.equal(fs.list("/objects").length, 4000);
    fs.close();
  }
  console.log(`Completed pair ${trial + 4}/13`);
}
const baseline = rows.filter((r) => r.version === "baseline");
const candidate = rows.filter((r) => r.version === "candidate");
const summary = {
  baseline: distribution(baseline.map((r) => r.ms)),
  candidate: distribution(candidate.map((r) => r.ms)),
  ratio: pairedRatio(
    baseline.map((r) => r.ms),
    candidate.map((r) => r.ms),
  ),
  baselineCalls: baseline[0].calls,
  candidateCalls: candidate[0].calls,
  baselineRows: baseline[0].returnedRows,
  candidateRows: candidate[0].returnedRows,
};
await writeFile(
  output,
  `${JSON.stringify({ node: process.version, fingerprints, warmupPairs: 3, measuredPairs: 10, rows, summary }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
