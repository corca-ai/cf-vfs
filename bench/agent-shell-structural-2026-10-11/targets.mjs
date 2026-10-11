import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [before, after, output] = process.argv.slice(2);
const records = Array.from({ length: 1200 }, (_, i) => ({
  id: i,
  name: `package-${i}`,
  description: "dependency metadata 한글 ".repeat(8),
}));
const files = {
  "/records.jsonl": records.map(JSON.stringify).join("\n"),
  "/array.json": JSON.stringify(records),
  "/lines": "alpha beta 한글\n".repeat(12000),
};
const scenarios = [
  { name: "jsonl-project", script: "jq -r .name /records.jsonl | wc -l", stdout: "1200\n" },
  { name: "array-project", script: "jq -r '.[].name' /array.json | wc -l", stdout: "1200\n" },
  { name: "jsonl-roundtrip", script: "jq -c . /records.jsonl | wc -l", stdout: "1200\n" },
  {
    name: "text-six-stages",
    script: "cat /lines | cat | cat | cat | cat | wc -l",
    stdout: "12000\n",
  },
  {
    name: "text-transform",
    script: "cat /lines | sed 's/alpha/gamma/g' | grep gamma | wc -l",
    stdout: "12000\n",
  },
];
const engines = {};
for (const [name, root] of [
  ["baseline", before],
  ["candidate", after],
]) {
  const base = pathToFileURL(`${resolve(root)}/`);
  const { Shell } = await import(new URL("src/shell/shell.js", base));
  const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", base));
  const { defaultShellCommands } = await import(new URL("src/shell/commands/default.js", base));
  const { ExecutionBudget } = await import(new URL("src/shell/budget.js", base));
  const fs = new NodeSqlFileSystem();
  for (const [path, body] of Object.entries(files)) await fs.writeFile(path, body);
  engines[name] = {
    fs,
    shell: new Shell({
      fileSystem: fs,
      commands: defaultShellCommands,
      limits: { maxSteps: 1000000 },
    }),
    ExecutionBudget,
  };
}
const rows = [];
try {
  for (const scenario of scenarios) {
    const rawMs = { baseline: [], candidate: [] },
      peaks = {};
    for (let pair = -5; pair < 20; pair++)
      for (const v of pairOrder(pair + 5)) {
        const start = performance.now();
        const r = await engines[v].shell.executeText({ script: scenario.script });
        const elapsed = performance.now() - start;
        assert.equal(r.exitCode, 0, JSON.stringify(r));
        assert.equal(r.stderr, "");
        assert.equal(r.stdout, scenario.stdout);
        if (pair >= 0) rawMs[v].push(elapsed);
      }
    for (const [v, { shell, ExecutionBudget }] of Object.entries(engines)) {
      const original = ExecutionBudget.prototype.buffered;
      let active = 0,
        peak = 0;
      ExecutionBudget.prototype.buffered = function (bytes) {
        const release = original.call(this, bytes);
        active += bytes;
        peak = Math.max(peak, active);
        let released = false;
        return () => {
          release();
          if (!released) {
            released = true;
            active -= bytes;
          }
        };
      };
      try {
        await shell.executeText({ script: scenario.script });
        peaks[v] = { peakAccountedBytes: peak, remaining: active };
      } finally {
        ExecutionBudget.prototype.buffered = original;
      }
    }
    rows.push({
      name: scenario.name,
      script: scenario.script,
      rawMs,
      baseline: distribution(rawMs.baseline),
      candidate: distribution(rawMs.candidate),
      ratio: pairedRatio(rawMs.baseline, rawMs.candidate),
      peaks,
    });
  }
} finally {
  for (const { fs } of Object.values(engines)) fs.close();
}
await writeFile(
  output,
  JSON.stringify({ node: process.version, raisedMaxSteps: 1000000, rows }, null, 2),
);
console.log(
  JSON.stringify(
    rows.map(({ name, ratio, peaks }) => ({ name, ratio, peaks })),
    null,
    2,
  ),
);
