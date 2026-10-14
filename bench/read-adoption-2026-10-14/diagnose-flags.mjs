import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { comparePoints } from "../../demo/public/benchmarks/paired.js";

const root = "bench/read-adoption-2026-10-14";
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(gunzipSync(await readFile(`${path}.gz`)));
  }
}
const assessment = await read(`${root}/public-full-assessment.json`);
const [baseline, candidate] = (await read(`${root}/public-full-comparison.json`)).history;
const same = (a, b) => ["group", "operation", "files", "cache"].every((k) => a[k] === b[k]);
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function absolute(point, arm) {
  return {
    ...point,
    runs: point.runs.map((run) => ({
      ...run,
      rows: run.rows.map((row) => ({
        ...row,
        samplesMs: arm === "reference" ? row.referenceMs : row.samplesMs,
        referenceMs: row.samplesMs.map(() => 1),
      })),
    })),
  };
}
const diagnostics = assessment.unaccepted.map((flag) => ({
  stage: Object.fromEntries(["group", "operation", "files", "cache"].map((k) => [k, flag.row[k]])),
  previous: flag.previous,
  initial: flag.initialPrevious,
  confirmation: flag.confirmationPrevious,
  frozenReference: flag.reference,
  baselineReference: flag.baselineReference,
  absolute: Object.fromEntries(
    ["reference", "candidate"].map((arm) => [
      arm,
      {
        estimate: comparePoints(absolute(baseline, arm), absolute(candidate, arm), [flag.row]),
        medianMs: [baseline, candidate].map((p) =>
          median(
            p.runs.flatMap((r) => {
              const row = r.rows.find((row) => same(row, flag.row));
              return arm === "reference" ? row.referenceMs : row.samplesMs;
            }),
          ),
        ),
      },
    ]),
  ),
  rawRuns: Object.fromEntries(
    [
      ["baseline", baseline],
      ["candidate", candidate],
    ].map(([label, point]) => [
      label,
      point.runs.map((run) => {
        const row = run.rows.find((row) => same(row, flag.row));
        return { runId: run.runId, reference: row.referenceMs, candidate: row.samplesMs };
      }),
    ]),
  ),
}));
await writeFile(
  `${root}/public-new-flag-diagnostics.json`,
  `${JSON.stringify(
    {
      note: "Diagnostic evidence, not a waiver. No GC/outlier/RPC subtraction or sample omission. All three paired previous-code signals remain flagged; absolute uncertainty does not disprove a normalized slowdown. The user was asked specifically about these additional three cases. Until explicit acceptance they remain subject to the planned regression gate.",
      diagnostics,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    diagnostics.map(({ stage, absolute }) => ({ stage, absolute })),
    null,
    2,
  ),
);
