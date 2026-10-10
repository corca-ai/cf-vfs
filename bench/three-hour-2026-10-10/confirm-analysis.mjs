import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { workloadKey } from "../../demo/public/benchmarks/summary.js";
import { pairedRatio } from "../comparison.mjs";

const load = (p) => JSON.parse(p.endsWith(".gz") ? gunzipSync(readFileSync(p)) : readFileSync(p));
const [first, second, out] = process.argv.slice(2);
const a = load(first),
  b = load(second);
for (const key of [
  "engine",
  "protocol",
  "credentials",
  "candidate",
  "identityTime",
  "fixtureRootMode",
])
  if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) throw Error(key);
const workloads = b.workloads.map((w) => {
  const key = workloadKey(w.stage);
  const select = (d, v) =>
    d.rows
      .filter((r) => !r.profile && r.version === v && workloadKey(r.stage) === key)
      .sort((x, y) => x.pair - y.pair)
      .map((r) => r.ms);
  const baseline = [...select(a, "baseline"), ...select(b, "baseline")],
    candidate = [...select(a, "candidate"), ...select(b, "candidate")];
  return {
    stage: w.stage,
    ratio: pairedRatio(baseline, candidate),
    rawMs: { baseline, candidate },
    blocks: [a.workloads.find((x) => workloadKey(x.stage) === key).ratio, w.ratio],
  };
});
const regressions = workloads.filter((w) => w.ratio.median > 1.05);
const confirmed = regressions.filter((w) => w.ratio.ci95[0] > 1);
const result = {
  protocol: a.protocol,
  candidate: a.candidate,
  credentials: a.credentials,
  inputs: [first, second],
  description:
    "All matched workloads and all twenty pairs from two independent targeted blocks; individual blocks remain visible. Not a full-suite comparison.",
  workloads,
  regressions,
  confirmed,
};
if (out) writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      confirmed,
      regressions: regressions.map(({ stage, ratio, blocks }) => ({ stage, ratio, blocks })),
    },
    null,
    2,
  ),
);
