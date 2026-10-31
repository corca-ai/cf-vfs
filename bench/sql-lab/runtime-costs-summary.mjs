import { readFileSync } from "node:fs";

// Usage: node runtime-costs-summary.mjs FILE.jsonl
// Medians per label and measurement, then each label's ratio to the first.
const rows = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const labels = [...new Set(rows.map((row) => row.label))];
const whats = [...new Set(rows.map((row) => row.what))];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
console.log(["measurement".padEnd(28), ...labels.map((label) => label.padStart(18))].join(""));
for (const what of whats) {
  const cells = labels.map((label) => {
    const values = rows
      .filter((row) => row.label === label && row.what === what)
      .map((row) => row.ms);
    return values.length === 0 ? "-" : `${median(values)} [${values.join(",")}]`;
  });
  console.log([what.padEnd(28), ...cells.map((cell) => cell.padStart(18))].join(""));
}
