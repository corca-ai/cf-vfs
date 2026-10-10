import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  geometricMean,
  summaryMetrics,
  workloadKey,
} from "../../demo/public/benchmarks/summary.js";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";
import { benchmarkPlan } from "./compiled/baseline-fixed/demo/benchmark-suite.js";

const [output] = process.argv.slice(2);
assert.ok(output, "Output path required");
const baseUrl = process.env.EVALUATION_URL ?? "https://cf-vfs-full-evaluation.donghun.workers.dev";
const vars = await readFile(new URL("./.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token, "Missing private evaluation token");
const trials = Number(process.env.PAIRS ?? 10),
  warmups = Number(process.env.WARMUPS ?? 2);
const groupKey = (stage) => `${stage.group}:${stage.files}:${stage.cache}`;
const groupFilter = new Set((process.env.BENCH_GROUPS ?? "").split(",").filter(Boolean));
const completePlan = benchmarkPlan().filter((stage) => stage.trial === 0);
const expectedPlan = completePlan.filter(
  (stage) => groupFilter.size === 0 || groupFilter.has(groupKey(stage)),
);
assert.ok(expectedPlan.length > 0);
const starts = completePlan.flatMap((stage, index) =>
  (index === 0 || groupKey(stage) !== groupKey(completePlan[index - 1])) &&
  (groupFilter.size === 0 || groupFilter.has(groupKey(stage)))
    ? [index]
    : [],
);
const room = `full-${randomUUID()}`;
const rows = [],
  placements = [];
const credentials = ["root", "demo"].includes(process.env.CREDENTIALS)
  ? process.env.CREDENTIALS
  : "none";
const colocated = process.env.COLOCATED === "1";
async function request(path, name, order, start, version) {
  const url = new URL(path, baseUrl);
  url.searchParams.set("credentials", credentials);
  url.searchParams.set("room", name);
  url.searchParams.set("order", order);
  if (version !== undefined) url.searchParams.set("version", version);
  if (start !== undefined) url.searchParams.set("start", start);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(value)}`);
  assert.equal(value.build, process.env.CANDIDATE, "Evaluation source changed during measurement");
  return value;
}
const metadata = {
  engine: "cloudflare-sqlite-rpc",
  protocol: "full-suite-colocated-alternating-fixed-git-v1",
  identityTime: 1700000000000,
  fixtureRootMode: credentials === "demo" ? 0o40777 : 0o40755,
  trials,
  warmups,
  fullPlan: groupFilter.size === 0,
  groups: [...groupFilter],
  credentials,
  colocated,
  baseUrl,
  room,
  startedAt: new Date().toISOString(),
  candidate: process.env.CANDIDATE ?? "unknown",
};
try {
  for (const profile of [false, true]) {
    const name = profile ? `${room}-profile` : room;
    for (let pair = profile ? 0 : -warmups; pair < (profile ? 1 : trials); pair++) {
      const [order] = pairOrder(pair);
      for (const version of colocated ? pairOrder(pair) : [undefined]) {
        await request("/setup", name, order, undefined, version);
        for (const start of starts) {
          const result = await request("/group", name, order, start, version);
          placements.push({ pair, profile, start, colo: result.colo });
          for (const row of result.rows) {
            assert.ok(row.ms > 0, `Unresolved zero timing: ${workloadKey(row.stage)}`);
            if (pair >= 0) rows.push({ pair, profile, ...row });
          }
          console.error(
            "pair",
            pair,
            profile ? "profile" : "timing",
            "version",
            version ?? "both",
            "stages",
            result.nextIndex,
            "colo",
            result.colo,
          );
          await writeFile(
            output,
            `${JSON.stringify({ ...metadata, rows, placements }, null, 2)}\n`,
          );
          assert.ok(result.nextIndex > start);
        }
      }
      if (pair >= 0) {
        const sample = rows.filter((row) => row.pair === pair && row.profile === profile);
        for (const a of sample.filter((row) => row.version === "baseline")) {
          const b = sample.find(
            (row) => row.version === "candidate" && workloadKey(row.stage) === workloadKey(a.stage),
          );
          assert.ok(b);
          assert.equal(a.verified, b.verified);
          assert.equal(a.iterations, b.iterations);
          assert.equal(a.verifiedBodies, b.verifiedBodies);
        }
      }
    }
  }
} finally {
  await Promise.allSettled([
    request("/clear", room, "baseline", undefined, colocated ? "baseline" : undefined),
    request("/clear", `${room}-profile`, "baseline", undefined, colocated ? "baseline" : undefined),
  ]);
}
const plan = rows
  .filter((row) => !row.profile && row.pair === 0 && row.version === "baseline")
  .map((row) => row.stage);
assert.deepEqual(plan, expectedPlan);
assert.equal(new Set(plan.map(workloadKey)).size, expectedPlan.length);
const workloads = plan.map((stage) => {
  const matching = rows.filter((row) => workloadKey(row.stage) === workloadKey(stage));
  const select = (version) =>
    matching.filter((row) => !row.profile && row.version === version).map((row) => row.ms);
  const baseline = select("baseline"),
    candidate = select("candidate");
  assert.equal(baseline.length, trials);
  assert.equal(candidate.length, trials);
  return {
    stage,
    baseline: distribution(baseline),
    candidate: distribution(candidate),
    ratio: pairedRatio(baseline, candidate),
    costs: matching.filter((row) => row.profile),
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
  const a = costs.find((row) => row.version === "baseline").sql,
    b = costs.find((row) => row.version === "candidate").sql;
  return b.statements > a.statements || b.rowsRead > a.rowsRead || b.rowsWritten > a.rowsWritten;
});
await writeFile(
  output,
  `${JSON.stringify({ ...metadata, completedAt: new Date().toISOString(), metrics, regressions, confirmed, costRegressions, workloads, rows, placements }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    metrics,
    regressions: regressions.length,
    confirmed: confirmed.length,
    costRegressions: costRegressions.length,
  }),
);
