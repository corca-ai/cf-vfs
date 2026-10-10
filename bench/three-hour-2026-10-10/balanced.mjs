import { readFile, writeFile } from "node:fs/promises";
import {
  geometricMean,
  summaryMetrics,
  workloadKey,
} from "../../demo/public/benchmarks/summary.js";
import { pairedRatio } from "../comparison.mjs";

const [source, destination] = process.argv.slice(2);
const value = JSON.parse(await readFile(source, "utf8"));
function blocks(ratios) {
  const samples = [];
  for (let index = 0; index + 1 < ratios.length; index += 2)
    samples.push(Math.sqrt(ratios[index] * ratios[index + 1]));
  return pairedRatio(
    samples.map(() => 1),
    samples,
  );
}
const workloads = value.workloads.map((workload) => {
  const samples = value.rows.filter(
    (row) => !row.profile && workloadKey(row.stage) === workloadKey(workload.stage),
  );
  const ratios = Array.from({ length: value.trials }, (_, pair) => {
    const selected = samples.filter((row) => row.pair === pair);
    return (
      selected.find((row) => row.version === "candidate").ms /
      selected.find((row) => row.version === "baseline").ms
    );
  });
  return { stage: workload.stage, ratios, balanced: blocks(ratios) };
});
const metrics = summaryMetrics.map((metric) => {
  const selected = workloads.filter(({ stage }) => metric.includes(stage));
  const ratios = Array.from({ length: value.trials }, (_, pair) =>
    geometricMean(selected.map((workload) => workload.ratios[pair])),
  );
  return { id: metric.id, ratios, balanced: blocks(ratios) };
});
const report = {
  source,
  protocol:
    "bootstrap adjacent opposite-order pair blocks; each block is the geometric mean of its two ratios",
  metrics,
  workloads,
};
if (destination) await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(metrics));
