import { writeFile } from "node:fs/promises";
import { distribution } from "../comparison.mjs";
import { readResult } from "./read-result.mjs";

const load = (name) => readResult(new URL(name, import.meta.url));
const forward = await Promise.all(["cf-mono-escaped-forward.json"].map(load));
const reversed = await load("cf-mono-escaped-reversed.json");
const ratios = (row) => row.rawMs.baseline.map((n, i) => row.rawMs.candidate[i] / n);
const phases = forward.map((x) => ratios(x.rows.find((r) => r.name === "escaped-json")));
const reverse = ratios(reversed.rows[0]);
const median = (values) => distribution(values).median;
let seed = 0x12345678;
const resample = (values) =>
  values.map(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[Math.floor((seed / 2 ** 32) * values.length)];
  });
const samples = Array.from({ length: 2000 }, () =>
  Math.sqrt(median(phases.flatMap(resample)) * median(resample(reverse))),
).sort((a, b) => a - b);
const q = (f) => {
  const i = (samples.length - 1) * f,
    a = Math.floor(i),
    b = Math.ceil(i);
  return samples[a] + (samples[b] - samples[a]) * (i - a);
};
const result = {
  workload: "escaped-json",
  forwardNewOverOld: median(phases.flat()),
  reversedNewOverOld: reversed.rows[0].ratio,
  conditionalCodeRatio: Math.sqrt(median(phases.flat()) * median(reverse)),
  ci95: [q(0.025), q(0.975)],
  pairs: {
    forward: phases.reduce((n, p) => n + p.length, 0),
    swapped: reversed.pairs,
  },
  assumptions:
    "Diagnostic separate-service crossover assumes stable multiplicative service/actor placement effects across deployments. Each Worker imports one library graph; fixed service namespaces and room name persist across code exchange. Both phase ratios are new/old, so the estimate is sqrt(forward * reversed). Resample matched pairs separately by phase. Not a replacement score, universal zero-regression claim, or proof of 5% noninferiority.",
};
await writeFile(
  new URL("./escaped-mono-crossover.json", import.meta.url),
  JSON.stringify(result, null, 2),
);
console.log(result);
