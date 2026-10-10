import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  geometricMean,
  summaryMetrics,
  workloadKey,
} from "../../demo/public/benchmarks/summary.js";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [baselineRoot, candidateRoot, output] = process.argv.slice(2);
const modules = {};
for (const [version, root] of [
  ["baseline", baselineRoot],
  ["candidate", candidateRoot],
]) {
  const url = pathToFileURL(`${resolve(root)}/`);
  modules[version] = {
    ...(await import(new URL("demo/benchmark-suite.js", url))),
    ...(await import(new URL("src/testing/node.js", url))),
  };
}
const trials = Number(process.env.PAIRS ?? 10);
const warmups = Number(process.env.WARMUPS ?? 2);
const completePlan = modules.baseline.benchmarkPlan().filter((stage) => stage.trial === 0);
assert.deepEqual(
  completePlan,
  modules.candidate.benchmarkPlan().filter((stage) => stage.trial === 0),
);
const groupFilter = new Set((process.env.BENCH_GROUPS ?? "").split(",").filter(Boolean));
const plan = completePlan.filter(
  (stage) =>
    groupFilter.size === 0 || groupFilter.has(`${stage.group}:${stage.files}:${stage.cache}`),
);
assert.ok(plan.length > 0);
const identityTime = process.env.FIXED_GIT_TIME === "1" ? 1700000000000 : undefined;
const credentials =
  process.env.CREDENTIALS === "demo"
    ? { uid: 1000, gid: 1000 }
    : process.env.CREDENTIALS === "root"
      ? { uid: 0, gid: 0 }
      : undefined;
const stageOrder = process.env.STAGE_ORDER === "1";
const rows = [];
function validate(stage) {
  return (
    (["coding-small", "coding-mixed"].includes(stage.group) &&
      ["clone", "commit-partial", "checkout-base", "checkout-main"].includes(stage.operation)) ||
    stage.operation === "remove-tree" ||
    stage.operation === "checkout-main" ||
    (stage.group === "git-shell" &&
      ["add-one", "add-changed", "add-removals"].includes(stage.operation))
  );
}
for (const profile of [false, true]) {
  for (let pair = profile ? 0 : -warmups; pair < (profile ? 1 : trials); pair++) {
    const engines = {};
    for (const version of ["baseline", "candidate"]) {
      let suite;
      const cost = { statements: 0, returnedRows: 0 };
      const fs = new modules[version].NodeSqlFileSystem({
        onEvent: (event) => suite?.onEvent(event),
        ...(profile
          ? {
              onStatement: (_query, returned) => {
                cost.statements++;
                cost.returnedRows += returned;
              },
            }
          : {}),
      });
      if (credentials?.uid === 1000) fs.setMetadata("/", { mode: 0o40777 });
      suite = new modules[version].PublicBenchmarkSuite(
        credentials === undefined ? fs : fs.forCredentials(credentials),
        identityTime,
      );
      engines[version] = { fs, suite, cost };
    }
    try {
      for (const [stageIndex, stage] of plan.entries()) {
        let expected;
        for (const version of pairOrder(pair + (stageOrder ? stageIndex : 0))) {
          const { suite, cost } = engines[version];
          cost.statements = 0;
          cost.returnedRows = 0;
          const started = performance.now();
          const value = await suite.run(stage);
          const ms = performance.now() - started;
          expected ??= value;
          assert.deepEqual(value, expected, workloadKey(stage));
          const observed = { ...cost };
          const verified = validate(stage) ? await suite.validate(stage) : 0;
          if (pair >= 0) rows.push({ pair, version, profile, stage, ms, ...observed, verified });
        }
      }
      for (const { suite } of Object.values(engines)) await suite.cleanup();
    } finally {
      for (const { fs } of Object.values(engines)) fs.close();
    }
    console.error("pair", pair, profile ? "SQL profile" : "timing");
    await writeFile(
      output,
      `${JSON.stringify({ trials, warmups, baselineRoot, candidateRoot, credentials, fixtureRootMode: credentials?.uid === 1000 ? 0o40777 : 0o40755, identityTime, fullPlan: groupFilter.size === 0, groups: [...groupFilter], stageOrder, rows }, null, 2)}\n`,
    );
  }
}
const workloads = plan.map((stage) => {
  const select = (version) =>
    rows
      .filter(
        (row) =>
          !row.profile && row.version === version && workloadKey(row.stage) === workloadKey(stage),
      )
      .map((row) => row.ms);
  const baseline = select("baseline"),
    candidate = select("candidate");
  return {
    stage,
    baseline: distribution(baseline),
    candidate: distribution(candidate),
    ratio: pairedRatio(baseline, candidate),
    costs: rows.filter((row) => row.profile && workloadKey(row.stage) === workloadKey(stage)),
  };
});
const metrics = summaryMetrics
  .filter((metric) => workloads.some(({ stage }) => metric.includes(stage)))
  .map((metric) => {
    const selected = workloads.filter(({ stage }) => metric.includes(stage));
    const ratios = Array.from({ length: trials }, (_, pair) =>
      geometricMean(
        selected.map(({ stage }) => {
          const values = rows.filter(
            (row) =>
              !row.profile && row.pair === pair && workloadKey(row.stage) === workloadKey(stage),
          );
          return (
            values.find((row) => row.version === "candidate").ms /
            values.find((row) => row.version === "baseline").ms
          );
        }),
      ),
    );
    return {
      id: metric.id,
      workloads: selected.length,
      ratio: pairedRatio(
        ratios.map(() => 1),
        ratios,
      ),
    };
  });
const regressions = workloads.filter(({ ratio }) => ratio.median > 1.05);
const confirmed = regressions.filter(({ ratio }) => ratio.ci95[0] > 1);
const costRegressions = workloads.filter(({ costs }) => {
  const a = costs.find((row) => row.version === "baseline"),
    b = costs.find((row) => row.version === "candidate");
  return b.statements > a.statements || b.returnedRows > a.returnedRows;
});
await writeFile(
  output,
  `${JSON.stringify({ trials, warmups, baselineRoot, candidateRoot, credentials, fixtureRootMode: credentials?.uid === 1000 ? 0o40777 : 0o40755, identityTime, fullPlan: groupFilter.size === 0, groups: [...groupFilter], stageOrder, metrics, regressions, confirmed, costRegressions, workloads, rows }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    metrics,
    regressions: regressions.length,
    confirmed: confirmed.length,
    costRegressions: costRegressions.length,
  }),
);
