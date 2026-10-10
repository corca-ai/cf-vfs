import { readFile, writeFile } from "node:fs/promises";

const data = JSON.parse(
  await readFile(
    new URL(process.argv[2] ?? "cf-reliability-and-diagnostics.json", import.meta.url),
    "utf8",
  ),
);
function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
}
const groups = new Map();
for (const row of data.samples) {
  const key = `${row.mixed === undefined ? "queue" : row.mixed ? "mixed" : "small"}/${row.operation}`;
  const rows = groups.get(key) ?? [];
  rows.push(row);
  groups.set(key, rows);
}
const summary = [...groups].map(([workload, rows]) => ({
  workload,
  n: rows.length,
  clientMs: distribution(rows.map((row) => row.clientMs)),
}));
await writeFile(
  new URL("performance-summary.json", import.meta.url),
  `${JSON.stringify({ summary, profiles: data.profiles.map(({ mixed, operation, counters }) => ({ mixed, operation, counters })) }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
