import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { comparePoints, estimateWorkloads } from "../../demo/public/benchmarks/paired.js";
import { assessPairedSnapshot } from "../paired-assessment.mjs";

const root = new URL("./", import.meta.url);
const label = process.argv[2] ?? "";
assert.match(label, /^[a-z0-9-]*$/u);
const prefix = label ? `cf-${label}-` : "cf-";
const read = async (name) => {
  try {
    return JSON.parse(await readFile(new URL(name, root), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(gunzipSync(await readFile(new URL(`${name}.gz`, root))));
  }
};
const save = async (name, value) =>
  writeFile(new URL(name, root), `${JSON.stringify(value, null, 2)}\n`);
for (const kind of ["task", "full"]) {
  const before = await read(`cf-${kind}-baseline-3.json`);
  const after = await read(`${prefix}${kind}-candidate-3.json`);
  const point = (snapshot) =>
    snapshot.history.find((p) => p.commitHash === snapshot.result.commitHash);
  const baseline = point(before),
    candidate = point(after);
  assert.equal(baseline.runs.length, 3);
  assert.equal(candidate.runs.length, 3);
  assert.equal(baseline.protocol.id, candidate.protocol.id);
  const combined = {
    ...after,
    provenance: {
      baseline: `cf-${kind}-baseline-3.json`,
      candidate: `${prefix}${kind}-candidate-3.json`,
    },
    history: [baseline, candidate],
  };
  await save(`${prefix}${kind}-comparison.json`, combined);
  if (kind === "task") {
    const rows = after.result.rows;
    await save(`${prefix}task-assessment.json`, {
      reference: estimateWorkloads(candidate, rows),
      previous: comparePoints(baseline, candidate, rows),
      costs: candidate.runs.map((run) => run.rows.map((row) => row.costs)),
    });
  } else {
    const report = assessPairedSnapshot(combined);
    await save(`${prefix}full-assessment.json`, report);
    const costs = await read(`${prefix}costs.json`);
    const same = (a, b) => a.group === b.group && a.files === b.files && a.cache === b.cache;
    const flags = report.rows.filter(
      (row) => row.reference?.value > 105 || row.previous?.value > 105,
    );
    const groups = [
      ...new Set([
        ...flags.flatMap((row) =>
          costs.rows.filter((cost) => same(row, cost.stage)).map((cost) => cost.group),
        ),
        ...costs.increases.map((cost) => cost.group),
      ]),
    ].sort((a, b) => a - b);
    await save(`${prefix}repeat-selection.json`, groups);
    await save(`${prefix}repeat-reasons.json`, { flags, costs: costs.increases });
    console.log({
      conclusion: report.conclusion,
      metrics: report.metrics,
      flaggedRows: flags.length,
      groups,
    });
  }
}
