import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const root = "bench/read-retry-2026-10-13";
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(gunzipSync(await readFile(path + ".gz")));
  }
}
const runs = await Promise.all(
  [1, 2, 3].map((i) => read(`${root}/cf-clean-candidate-costs-${i}.json`)),
);
const keys = ["statements", "rowsRead", "rowsWritten"];
const build = "95ea59dd1e5f8dcb3885c1d1870295ed5977a4f9c0ca5162f5b89056049b7763";
for (const run of runs) {
  assert.equal(run.build, build);
  assert.equal(run.completedGroups, run.groups);
  assert.equal(run.rows.length, 190);
}
const rows = runs[0].rows.map((row, i) => {
  const samples = runs.map((run) => {
    const sample = run.rows[i];
    assert.deepEqual(sample.stage, row.stage);
    for (const arm of ["reference", "candidate"])
      for (const key of keys) assert.ok(Number.isFinite(sample[arm][key]) && sample[arm][key] >= 0);
    return sample;
  });
  const changes = Object.fromEntries(
    keys.map((key) => [
      key,
      samples.map((sample) => ({
        reference: sample.reference[key],
        candidate: sample.candidate[key],
        delta: sample.candidate[key] - sample.reference[key],
      })),
    ]),
  );
  return { stage: row.stage, changes };
});
const increases = rows.filter((row) =>
  keys.some((key) => row.changes[key].some((sample) => sample.delta > 0)),
);
const repeatedIncreases = rows.filter((row) =>
  keys.some((key) => row.changes[key].every((sample) => sample.delta > 0)),
);
const totals = runs.map((run) => run.totals);
await writeFile(
  `${root}/cf-clean-cost-assessment.json`,
  JSON.stringify({ build, runs: 3, totals, increases, repeatedIncreases, rows }, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    { totals, increases: increases.length, repeatedIncreases: repeatedIncreases.length },
    null,
    2,
  ),
);
