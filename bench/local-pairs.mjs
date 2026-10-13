import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workloadKey } from "../demo/public/benchmarks/summary.js";
import { pairOrder } from "./comparison.mjs";

const [baselineRoot, candidateRoot, output] = process.argv.slice(2);
assert.ok(baselineRoot && candidateRoot && output, "Use BASELINE_GRAPH CANDIDATE_GRAPH OUTPUT");
const trials = Number(process.env.PAIRS ?? 6);
const warmups = Number(process.env.WARMUPS ?? 2);
const orderOffset = Number(process.env.ORDER_OFFSET ?? 0);
assert.ok(Number.isInteger(trials) && trials > 0 && Number.isInteger(warmups) && warmups >= 0);
assert.ok(orderOffset === 0 || orderOffset === 1);
const modules = {};
for (const [version, directory] of [
  ["baseline", baselineRoot],
  ["candidate", candidateRoot],
]) {
  const url = pathToFileURL(`${resolve(directory)}/`);
  modules[version] = {
    ...(await import(new URL("demo/benchmark-suite.js", url))),
    ...(await import(new URL("src/testing/node.js", url))),
  };
}
const all = modules.baseline.benchmarkPlan().filter((stage) => stage.trial === 0);
assert.deepEqual(
  all,
  modules.candidate.benchmarkPlan().filter((stage) => stage.trial === 0),
);
const selected = new Set((process.env.BENCH_GROUPS ?? "").split(",").filter(Boolean));
const key = (stage) => `${stage.group}:${stage.files}:${stage.cache}`;
const plan = all.filter((stage) => !selected.size || selected.has(key(stage)));
assert.ok(plan.length);
const groups = [];
for (const stage of plan) {
  if (groups.at(-1)?.[0] && key(groups.at(-1)[0]) === key(stage)) groups.at(-1).push(stage);
  else groups.push([stage]);
}
const credentials =
  process.env.CREDENTIALS === "demo"
    ? { uid: 1000, gid: 1000 }
    : process.env.CREDENTIALS === "root"
      ? { uid: 0, gid: 0 }
      : undefined;
const identityTime = process.env.FIXED_GIT_TIME === "1" ? 1700000000000 : undefined;
const limits = {
  workspaceId: "benchmark-fixture",
  maxEntries: 20_000,
  maxInlineLogicalBytes: 32 * 1024 * 1024,
  maxInFlightBufferedBytes: 16 * 1024 * 1024,
};
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
async function save(complete) {
  const costs = plan.map((stage) => {
    const samples = rows.filter(
      (row) => row.profile && workloadKey(row.stage) === workloadKey(stage),
    );
    return { stage, costs: samples };
  });
  const costRegressions = costs.filter(({ costs }) => {
    const before = costs.find((row) => row.version === "baseline"),
      after = costs.find((row) => row.version === "candidate");
    return (
      before &&
      after &&
      (after.statements > before.statements || after.returnedRows > before.returnedRows)
    );
  });
  await writeFile(
    output,
    JSON.stringify(
      {
        complete,
        protocol: {
          id: "local-group-v1",
          pairUnit: "group",
          description:
            "Fresh fixture per arm/group; complete group before switching arms; untimed setup/validation/cleanup; separate SQL replay. No GC trimming.",
        },
        trials,
        warmups,
        orderOffset,
        baselineRoot,
        candidateRoot,
        credentials,
        identityTime,
        limits,
        fullPlan: selected.size === 0,
        groups: [...selected],
        workloads: plan.map((stage) => ({ stage })),
        regressions: [],
        costRegressions,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
}
try {
  for (const profile of [false, true])
    for (let pair = profile ? 0 : -warmups; pair < (profile ? 1 : trials); pair++) {
      for (const stages of groups) {
        const expected = new Map();
        for (const version of pairOrder(pair + orderOffset)) {
          let suite;
          const cost = { statements: 0, returnedRows: 0 };
          const fs = new modules[version].NodeSqlFileSystem({
            ...limits,
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
          try {
            if (credentials?.uid === 1000) fs.setMetadata("/", { mode: 0o40777 });
            suite = new modules[version].PublicBenchmarkSuite(
              credentials ? fs.forCredentials(credentials) : fs,
              identityTime,
            );
            for (const stage of stages) {
              cost.statements = 0;
              cost.returnedRows = 0;
              const started = performance.now();
              const value = await suite.run(stage);
              const ms = performance.now() - started,
                observed = { ...cost };
              const verified = validate(stage) ? await suite.validate(stage) : 0;
              const outcome = { ...value, verifiedBodies: verified };
              if (expected.has(workloadKey(stage)))
                assert.deepEqual(outcome, expected.get(workloadKey(stage)));
              else expected.set(workloadKey(stage), outcome);
              if (pair >= 0)
                rows.push({ pair, version, profile, stage, ms, ...observed, verified });
            }
          } finally {
            try {
              await suite?.cleanup();
            } finally {
              fs.close();
            }
          }
        }
      }
      console.error("pair", pair, profile ? "SQL replay" : "timing", "order offset", orderOffset);
      await save(false);
    }
  assert.equal(rows.length, plan.length * 2 * (trials + 1));
  await save(true);
} catch (error) {
  await save(false);
  throw error;
}
