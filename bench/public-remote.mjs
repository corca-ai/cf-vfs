import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { assessPairs } from "../demo/public/benchmarks/summary.js";
import { comparePublicResults } from "./public-comparison.mjs";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}
const base = new URL(option("--url") ?? "https://vfs.borca.ai");
if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))
  throw new Error("Use HTTPS for authenticated benchmarks");
let token = process.env.CF_VFS_PUBLIC_BENCHMARK_TOKEN;
if (!token) {
  const contents = await readFile(new URL("../.dev.vars.public", import.meta.url), "utf8");
  token = contents
    .match(/^\s*PUBLIC_BENCHMARK_TOKEN\s*=\s*(.+?)\s*$/m)?.[1]
    ?.replace(/^(["'])(.*)\1$/, "$2");
}
if (!token) throw new Error("Set CF_VFS_PUBLIC_BENCHMARK_TOKEN or .dev.vars.public");
const localBuild = (
  await readFile(new URL("../demo/benchmark-build.ts", import.meta.url), "utf8")
).match(/"([a-f0-9]{64})"/u)?.[1];
const expectedBuild = option("--build") ?? localBuild;
async function json(path, init) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const response = await fetch(new URL(path, base), init);
    if ([409, 503].includes(response.status) && Date.now() < deadline) {
      await response.body?.cancel();
      await delay(2000);
      continue;
    }
    if (!response.ok) throw new Error(`Benchmark endpoint returned ${response.status}`);
    return response.json();
  }
}
const claim = await json("/api/benchmarks/developer", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    ...(expectedBuild ? { "X-Vfs-Expected-Build": expectedBuild } : {}),
  },
});
console.error(claim.reused ? "Joining active run" : "Started fresh CF benchmark");
const expectedBuildAtStart = expectedBuild;
if (expectedBuildAtStart && claim.buildId !== expectedBuildAtStart)
  throw new Error("Expected implementation is not active; retry after propagation");
const started = Date.now();
let state = claim;
while (state.status === "running") {
  if (Date.now() - started > 15 * 60_000) throw new Error("Timed out waiting for benchmark");
  await delay(2000);
  state = await json("/api/benchmarks");
}
if (state.status !== "ready" || !state.result) throw new Error(state.error ?? "Benchmark failed");
const result = state.result;
if (
  (expectedBuild && result.buildId !== expectedBuild) ||
  (claim.buildId && result.buildId !== claim.buildId) ||
  (claim.runId && result.runId !== claim.runId)
)
  throw new Error("Benchmark result belongs to a different implementation or run");
const baselinePath = option("--baseline");
if (baselinePath) {
  const allowAddedWorkloads = process.argv.includes("--allow-added-workloads");
  const saved = JSON.parse(await readFile(baselinePath, "utf8"));
  const baseline = saved.result ?? saved;
  const pairs = comparePublicResults(baseline, result, allowAddedWorkloads);
  const assessment = assessPairs(pairs);
  console.error("Full-suite geometric means (candidate / baseline; lower is better):");
  for (const metric of assessment.metrics)
    console.error(`${metric.label}: ${metric.ratio === null ? "n/a" : metric.ratio.toFixed(3)}x`);
  console.error(
    `${assessment.regressions.length} workloads exceed +5%; ${assessment.unresolved.length} unresolved. Descriptive screening only.`,
  );
  if (args.includes("--check-regressions") && assessment.requiresReview) process.exitCode = 2;
  console.error(
    "operation/files/cache: previous -> current ms (ratio; three samples, descriptive only)",
  );
  for (const { row, previous: old } of pairs) {
    if (old === undefined) {
      console.error(
        `${row.group}/${row.operation}/${row.files}/${row.cache}: new workload; no baseline`,
      );
      continue;
    }
    console.error(
      `${row.group}/${row.operation}/${row.files}/${row.cache}: ${old.medianMs} -> ${row.medianMs} (${old.medianMs > 0 ? (row.medianMs / old.medianMs).toFixed(2) : "n/a"}x)`,
    );
  }
}
const output = option("--out");
if (output) await writeFile(output, `${JSON.stringify(state, null, 2)}\n`);
else console.log(JSON.stringify(state, null, 2));
console.error(
  `Completed ${result.runId}; deployment ${result.deploymentId}; ${result.verified} checks`,
);
