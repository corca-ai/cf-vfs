// Unused historical draft: direct HTTP may change runner placement.
// Adoption evidence uses complete coordinator runs; see report.md.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { estimatePaired } from "../../demo/public/benchmarks/paired.js";
import { workloadKey } from "../../demo/public/benchmarks/summary.js";

const [base, build, selection, output] = process.argv.slice(2);
assert.ok(base?.startsWith("https://") && build && selection && output);
const groups = JSON.parse(await readFile(selection, "utf8"));
assert.ok(Array.isArray(groups) && groups.every(Number.isInteger));
const vars = await readFile(new URL("../../.dev.vars.public", import.meta.url), "utf8");
const token = vars
  .match(/^\s*PUBLIC_BENCHMARK_TOKEN\s*=\s*(.+?)\s*$/m)?.[1]
  ?.replace(/^(["'])(.*)\1$/, "$2");
assert.ok(token);
const observations = [];
for (const group of groups) {
  for (let pair = -1; pair < 10; pair++) {
    const response = await fetch(new URL(`/repeat?group=${group}&pair=${pair}`, base), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(240000),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.build, build);
    observations.push({ group, pair, ...value.group });
    await writeFile(output, `${JSON.stringify({ build, groups, observations }, null, 2)}\n`);
    console.error(`CF repeat group ${group}, pair ${pair}`);
  }
}
const indexed = new Map();
for (const observation of observations.filter((value) => value.pair >= 0)) {
  for (const row of observation.rows) {
    const key = workloadKey(row);
    const entry = indexed.get(key) ?? { row, logs: [] };
    assert.equal(row.samplesMs.length, 1);
    assert.equal(row.referenceMs.length, 1);
    entry.logs.push(Math.log(row.samplesMs[0] / row.referenceMs[0]));
    indexed.set(key, entry);
  }
}
const estimates = [...indexed.values()].map(({ row, logs }) => {
  assert.equal(logs.length, 10);
  return { row, estimate: estimatePaired([logs]) };
});
const confirmed = estimates.filter(
  ({ estimate }) => estimate?.value > 105 && estimate.ci95?.[0] > 100,
);
await writeFile(
  output,
  `${JSON.stringify({ build, groups, observations, estimates, confirmed }, null, 2)}\n`,
);
console.log({ workloads: estimates.length, confirmed: confirmed.length });
