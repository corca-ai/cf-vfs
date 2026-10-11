import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { distribution } from "../comparison.mjs";

// Resample matched baseline/candidate pairs within each independently timed
// workload, then preserve the same geometric mean of workload median ratios.
const summaries = [];
for (const name of ["local-ten.json", "cf-ten.json"]) {
  const result = JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
  const ratios = result.rows.map(({ rawMs }) =>
    rawMs.baseline.map((value, index) => rawMs.candidate[index] / value),
  );
  const geometric = (values) =>
    Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
  const point = geometric(ratios.map((values) => distribution(values).median));
  assert.ok(Math.abs(point - result.geometricRatio) < 1e-12);
  let seed = 0x12345678;
  const samples = [];
  for (let sample = 0; sample < 2000; sample++) {
    samples.push(
      geometric(
        ratios.map(
          (values) =>
            distribution(
              values.map(() => {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                return values[Math.floor((seed / 2 ** 32) * values.length)];
              }),
            ).median,
        ),
      ),
    );
  }
  samples.sort((a, b) => a - b);
  const percentile = (fraction) => {
    const index = (samples.length - 1) * fraction;
    const low = Math.floor(index),
      high = Math.ceil(index);
    return samples[low] + (samples[high] - samples[low]) * (index - low);
  };
  summaries.push({
    input: name,
    ratio: point,
    ci95: [percentile(0.025), percentile(0.975)],
    scoreImprovement: 1 / point - 1,
    method: `geometric mean of ${result.rows.length} paired workload median ratios; 2000 deterministic within-workload matched-pair bootstrap replicates`,
    seed: "0x12345678",
  });
}
await writeFile(new URL("agent-summary.json", import.meta.url), JSON.stringify(summaries, null, 2));
console.log(JSON.stringify(summaries, null, 2));
