import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";
import { scenarios } from "./scenarios.ts";

const [before, after, output] = process.argv.slice(2);
const engines = {};
for (const [version, root] of [
  ["baseline", before],
  ["candidate", after],
]) {
  const base = pathToFileURL(`${resolve(root)}/`);
  const { Shell } = await import(new URL("src/shell/shell.js", base));
  const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", base));
  const { defaultShellCommands } = await import(new URL("src/shell/commands/default.js", base));
  const fs = new NodeSqlFileSystem();
  engines[version] = { fs, shell: new Shell({ fileSystem: fs, commands: defaultShellCommands }) };
}
const rows = [];
try {
  for (const scenario of scenarios) {
    const rawMs = { baseline: [], candidate: [] };
    for (let pair = -3; pair < 20; pair++) {
      for (const version of pairOrder(pair + 3)) {
        const start = performance.now();
        const result = await engines[version].shell.executeText({ script: scenario.script });
        const ms = performance.now() - start;
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, scenario.stdout);
        if (pair >= 0) rawMs[version].push(ms);
      }
    }
    rows.push({
      name: scenario.name,
      baseline: distribution(rawMs.baseline),
      candidate: distribution(rawMs.candidate),
      ratio: pairedRatio(rawMs.baseline, rawMs.candidate),
      rawMs,
    });
  }
} finally {
  for (const { fs } of Object.values(engines)) fs.close();
}
const ratio = Math.exp(
  rows.reduce((sum, row) => sum + Math.log(row.ratio.median), 0) / rows.length,
);
await writeFile(
  output,
  JSON.stringify({ node: process.version, pairs: 20, rows, geometricRatio: ratio }, null, 2),
);
console.log(
  JSON.stringify(
    { geometricRatio: ratio, rows: rows.map(({ name, ratio }) => ({ name, ratio })) },
    null,
    2,
  ),
);
