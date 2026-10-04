import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution } from "./comparison.mjs";
import { createTextSuite, workloadNames } from "./text-suite.mjs";

const root = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}/`)
  : new URL("../dist/", import.meta.url);
const suite = await createTextSuite(root);
const rows = [];
try {
  for (const name of workloadNames) {
    await suite.prepare(name);
    for (let index = 0; index < 3; index += 1) await suite.run(name);
    const durations = [];
    let costs;
    for (let index = 0; index < 11; index += 1) {
      const started = performance.now();
      costs = await suite.run(name);
      durations.push(performance.now() - started);
    }
    const { median, p10, p90 } = distribution(durations);
    rows.push({ name, medianMs: median, p10Ms: p10, p90Ms: p90, ...costs });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        warmups: 3,
        samples: 11,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  suite.close();
}
