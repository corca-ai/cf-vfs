import { readFile, writeFile } from "node:fs/promises";
import { distribution } from "../comparison.mjs";

const files = ["cf-hybrid.json", "cf-escaped-repeat.json"];
const phases = [];
for (const file of files) {
  const x = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
  const row = x.rows.find((r) => r.name === "escaped-json");
  phases.push({
    file,
    ratio: row.ratio,
    ratios: row.rawMs.baseline.map((n, i) => row.rawMs.candidate[i] / n),
  });
}
const point = distribution(phases.flatMap((p) => p.ratios)).median;
let seed = 0x12345678;
const samples = Array.from(
  { length: 2000 },
  () =>
    distribution(
      phases.flatMap((p) =>
        p.ratios.map(() => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return p.ratios[Math.floor((seed / 2 ** 32) * p.ratios.length)];
        }),
      ),
    ).median,
).sort((a, b) => a - b);
const q = (f) => {
  const i = (samples.length - 1) * f,
    a = Math.floor(i),
    b = Math.ceil(i);
  return samples[a] + (samples[b] - samples[a]) * (i - a);
};
const result = {
  workload: "escaped-json",
  phases: phases.map(({ ratios, ...p }) => ({ ...p, pairs: ratios.length })),
  pooled: {
    point,
    ci95: [q(0.025), q(0.975)],
    method:
      "Median of 40 matched ratios; 2000 bootstrap replicates resampling within each 20-pair phase; seed 0x12345678.",
  },
};
await writeFile(new URL("./escaped-pooled.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(result);
