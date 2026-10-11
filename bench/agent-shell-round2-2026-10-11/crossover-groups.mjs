import { writeFile } from "node:fs/promises";
import { distribution } from "../comparison.mjs";
import { readResult } from "./read-result.mjs";

const load = (name) => readResult(new URL(name, import.meta.url));
const f = await load("cf-groups-repeat.json"),
  r = await load("cf-groups-swapped.json");
const key = (s) => JSON.stringify([s.group, s.operation, s.files, s.cache]);
const ratioValues = (data, stage) => {
  const a = data.rows.filter(
    (x) => !x.profile && x.version === "baseline" && key(x.stage) === key(stage),
  );
  const b = new Map(
    data.rows
      .filter((x) => !x.profile && x.version === "candidate" && key(x.stage) === key(stage))
      .map((x) => [x.pair, x.ms]),
  );
  return a.map((x) => b.get(x.pair) / x.ms);
};
const median = (values) => distribution(values).median;
const rows = f.workloads.map((w) => {
  const forward = ratioValues(f, w.stage),
    reverse = ratioValues(r, w.stage);
  let seed = 0x12345678;
  const sample = (values) =>
    values.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return values[Math.floor((seed / 2 ** 32) * values.length)];
    });
  const draws = Array.from({ length: 2000 }, () =>
    Math.sqrt(median(sample(forward)) / median(sample(reverse))),
  ).sort((a, b) => a - b);
  const q = (p) => {
    const i = (draws.length - 1) * p,
      a = Math.floor(i),
      b = Math.ceil(i);
    return draws[a] + (draws[b] - draws[a]) * (i - a);
  };
  return {
    stage: w.stage,
    forwardNewOverOld: w.ratio,
    swappedOldOverNew: r.workloads.find((x) => key(x.stage) === key(w.stage)).ratio,
    conditionalCodeRatio: Math.sqrt(median(forward) / median(reverse)),
    ci95: [q(0.025), q(0.975)],
  };
});
const result = {
  rows,
  assumptions:
    "Diagnostic stable multiplicative import-slot model, ten matched pairs in each phase. Both phases use the same complete four-group subset and order, not the full-plan ambient namespace. No subset/crossover score replaces the full result or proves 5% noninferiority. Multiple comparisons are exploratory.",
};
await writeFile(
  new URL("./group-crossover.json", import.meta.url),
  JSON.stringify(result, null, 2),
);
console.log(
  rows
    .filter((x) =>
      [
        "init",
        "checkout-old",
        "add-partial",
        "add-one",
        "status-final",
        "fetch-unchanged",
        "add-changed",
        "populate",
      ].includes(x.stage.operation),
    )
    .map((x) => ({ stage: x.stage, codeRatio: x.conditionalCodeRatio, ci: x.ci95 })),
);
console.log({
  material: rows
    .filter((x) => x.conditionalCodeRatio > 1.05 && x.ci95[0] > 1)
    .map((x) => ({ stage: x.stage, ratio: x.conditionalCodeRatio, ci: x.ci95 })),
});
