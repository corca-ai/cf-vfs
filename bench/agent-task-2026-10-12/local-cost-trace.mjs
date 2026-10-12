// Diagnostic only: generated from local-pairs; no latency claim.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workloadKey } from "../../demo/public/benchmarks/summary.js";
import { pairOrder } from "../comparison.mjs";

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
      const cost = { statements: 0, returnedRows: 0, queries: {} };
      const fs = new modules[version].NodeSqlFileSystem({
        onEvent: (event) => suite?.onEvent(event),
        ...(profile
          ? {
              onStatement: (_query, returned) => {
                cost.queries[_query] = (cost.queries[_query] ?? 0) + 1;
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
          cost.queries = {};
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
