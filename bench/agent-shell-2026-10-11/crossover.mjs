import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { distribution } from "../comparison.mjs";

const load = async (name) => {
  const bytes = await readFile(new URL(name, import.meta.url));
  return JSON.parse(name.endsWith(".gz") ? gunzipSync(bytes) : bytes);
};
const phases = await Promise.all([
  load("full-cf-demo.json.gz"),
  load("cf-regression-repeat.json.gz"),
  load("cf-regression-second-repeat.json.gz"),
]);
const swapped = await load("cf-cache-swapped.json");
const aa = await load("cf-cache-aa.json");
const ratios = (phase) => {
  const select = (version) =>
    phase.rows
      .filter(
        (r) =>
          !r.profile &&
          r.version === version &&
          r.stage.group === "files" &&
          r.stage.files === 100 &&
          r.stage.cache &&
          r.stage.operation === "read",
      )
      .map((r) => r.ms);
  const before = select("baseline"),
    after = select("candidate");
  return before.map((v, i) => after[i] / v);
};
const forward = phases.map(ratios),
  reverse = ratios(swapped);
const median = (values) => distribution(values).median;
let seed = 0x12345678;
const resample = (values) =>
  values.map(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[Math.floor((seed / 2 ** 32) * values.length)];
  });
const estimate = (a, b) => Math.sqrt(median(a.flat()) / median(b));
const samples = Array.from({ length: 2000 }, () =>
  estimate(forward.map(resample), resample(reverse)),
).sort((a, b) => a - b);
const result = {
  workload: "files:100:true/read",
  forwardNewOverOld: median(forward.flat()),
  sameBuildAfterOverBefore: median(ratios(aa)),
  swappedOldOverNew: median(reverse),
  conditionalCodeRatio: estimate(forward, reverse),
  ci95: [samples[49], samples[1949]],
  assumptions:
    "Diagnostic crossover assuming a stable multiplicative import-slot effect across deployments. Resample matched pairs within each forward phase and the reversed run. This is not a replacement full-suite score or proof of 5% noninferiority.",
  pairs: { forward: 30, sameBuild: 20, swapped: 50 },
  seed: "0x12345678",
};
await writeFile(new URL("crossover.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
