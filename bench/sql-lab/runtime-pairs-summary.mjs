import { readFileSync } from "node:fs";

// Usage: node runtime-pairs-summary.mjs FILE.jsonl
// Per measurement: paired candidate/baseline ratios, their geometric mean
// with a bootstrap 95% interval, and both arms' medians.
const rows = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const geo = (values) =>
  Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
let seed = 1;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
for (const what of [...new Set(rows.map((row) => row.what))]) {
  const keyed = new Map();
  for (const row of rows.filter((row) => row.what === what)) {
    const key = `${row.session}#${row.pair}`;
    keyed.set(key, { ...keyed.get(key), [row.version]: row.ms });
  }
  const ratios = [...keyed.values()]
    .filter((pair) => pair.baseline && pair.candidate)
    .map((pair) => pair.candidate / pair.baseline);
  const boot = Array.from({ length: 2000 }, () =>
    geo(ratios.map(() => ratios[Math.floor(random() * ratios.length)])),
  ).sort((a, b) => a - b);
  const arm = (version) =>
    median(rows.filter((row) => row.what === what && row.version === version).map((row) => row.ms));
  console.log(
    `${what.padEnd(28)} pairs ${String(ratios.length).padStart(3)}  ratio ${geo(ratios).toFixed(3)} [${boot[50].toFixed(3)}, ${boot[1949].toFixed(3)}]  baseline ${arm("baseline")} ms  candidate ${arm("candidate")} ms`,
  );
}
