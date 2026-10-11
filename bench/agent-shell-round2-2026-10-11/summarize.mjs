import { readFile, writeFile } from "node:fs/promises";
import { distribution } from "../comparison.mjs";

const summaries = [];
for (const name of process.argv.slice(2)) {
  const result = JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
  for (const cohort of ["original-ten", "stress-two", "all-twelve"]) {
    const rows = result.rows.filter(
      (_, i) => cohort === "all-twelve" || (cohort === "original-ten" ? i < 10 : i >= 10),
    );
    if (!rows.length) continue;
    const ratios = rows.map(({ rawMs }) => rawMs.baseline.map((ms, i) => rawMs.candidate[i] / ms));
    const geometric = (values) =>
      Math.exp(values.reduce((sum, n) => sum + Math.log(n), 0) / values.length);
    const point = geometric(ratios.map((values) => distribution(values).median));
    let seed = 0x12345678;
    const samples = Array.from({ length: 2000 }, () =>
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
    ).sort((a, b) => a - b);
    const percentile = (f) => {
      const i = (samples.length - 1) * f,
        a = Math.floor(i),
        b = Math.ceil(i);
      return samples[a] + (samples[b] - samples[a]) * (i - a);
    };
    summaries.push({
      input: name,
      cohort,
      workloads: rows.length,
      ratio: point,
      ci95: [percentile(0.025), percentile(0.975)],
      method: "2000 within-workload matched-pair bootstrap replicates; seed 0x12345678",
    });
  }
}
await writeFile(
  new URL("./target-summary.json", import.meta.url),
  `${JSON.stringify(summaries, null, 2)}\n`,
);
console.log(summaries);
