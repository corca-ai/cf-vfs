import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  armOrder,
  benchmarkGroups,
  mergeRows,
  PAIRS_PER_RUN,
  pairedPlan,
  rowKey,
} from "../demo/benchmark-protocol.js";
import { benchmarkPlan } from "../demo/benchmark-suite.js";
// @ts-expect-error Browser/CLI shared statistics module.
import * as paired from "../demo/public/benchmarks/paired.js";

const { comparePoints, estimatePaired, pairedRow, pairedSummary } = paired;

const row = {
  group: "files" as const,
  operation: "read",
  files: 100,
  cache: false,
  iterations: 100,
  samplesMs: [100, 100, 100, 100, 100, 100],
  referenceMs: [100, 100, 100, 100, 100, 100],
  medianMs: 100,
  minMs: 100,
  maxMs: 100,
};
const point = (ratios: number[]) => ({
  protocol: { id: "p", referenceHash: "r", pairsPerRun: 6 },
  engine: "e",
  measurement: "m",
  rows: [row],
  runs: ratios.map((ratio, i) => ({
    runId: String(i),
    rows: [{ ...row, samplesMs: row.samplesMs.map((x) => x * ratio) }],
  })),
});
it("keeps the complete cohort, groups dependencies, and balances measured arm order", () => {
  expect(benchmarkGroups().flat()).toEqual(benchmarkPlan().filter((s) => s.trial === 0));
  const plan = pairedPlan();
  expect(plan.filter((g) => g.pair === 0).flatMap((g) => g.stages)).toHaveLength(190);
  for (const offset of [0, 1]) {
    const first = Array.from({ length: PAIRS_PER_RUN }, (_, i) => armOrder(i, offset)[0]);
    expect(first.filter((a) => a === "candidate")).toHaveLength(PAIRS_PER_RUN / 2);
  }
});
it("uses paired ratios so correlated environmental slowdowns cancel", () => {
  const p = point([0.8, 0.8, 0.8]);
  for (const run of p.runs) {
    first(run.rows).samplesMs = [80, 800, 8, 160, 16, 80];
    first(run.rows).referenceMs = [100, 1000, 10, 200, 20, 100];
  }
  const estimate = pairedRow(p, row);
  expect(estimate.value).toBeCloseTo(80);
  expect(estimate.ci95[1]).toBeCloseTo(80);
  expect(estimate.status).toBe("faster");
});
it("accounts for between-run drift instead of treating repeated pairs as independent runs", () => {
  const estimate = pairedRow(point([0.8, 1.2]), row);
  expect(estimate.runs).toBe(2);
  expect(estimate.pairs).toBe(12);
  expect(estimate.status).toBe("collecting");
  expect(estimate.ci95[0]).toBeLessThan(80);
  expect(estimate.ci95[1]).toBeGreaterThan(120);
  expect(pairedRow(point([1, 1, 1]), row).status).toBe("uncertain");
});
it("never removes zeros or changes the cohort to obtain a better score", () => {
  const p = point([1]);
  first(first(p.runs).rows).samplesMs[0] = 0;
  expect(pairedRow(p, row)).toBeNull();
  const metrics = pairedSummary([p], p, [{ id: "overall", includes: () => true }]);
  expect(metrics[0].workloads).toBe(1);
  expect(metrics[0].excluded).toBe(0);
  expect(metrics[0].points[0].status).toBe("unresolved");
  expect(metrics[0].points[0].value).toBeNull();
  expect(estimatePaired([[Number.NaN]])).toBeNull();
});
it("refuses to mix protocol series and preserves matching samples when checkpointing", () => {
  const p = point([1]);
  const other = { ...p, protocol: { ...p.protocol, id: "old" } };
  expect(pairedSummary([other, p], p, [{ id: "overall", includes: () => true }])[0].skipped).toBe(
    1,
  );
  const rows = mergeRows(
    [{ ...row, samplesMs: [2], referenceMs: [4] }],
    [{ ...row, samplesMs: [6], referenceMs: [8] }],
  );
  expect(rows[0]).toMatchObject({ samplesMs: [2, 6], referenceMs: [4, 8], medianMs: 4 });
  expect(rowKey(first(rows))).toBe(rowKey(row));
});

it("detects incremental regression even when both commits beat the frozen reference", () => {
  const result = comparePoints(point([0.8, 0.801, 0.799]), point([0.9, 0.901, 0.899]), [row]);
  expect(result.value).toBeCloseTo(112.5, 1);
  expect(result.status).toBe("slower");
  expect(result.ci95[0]).toBeGreaterThan(100);
  expect(comparePoints(point([1]), point([0.8]), [row]).status).toBe("collecting");
});

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected an observation");
  return value;
}

it("keeps equal workload weights instead of letting long operations dominate the aggregate", () => {
  const p = point([0.5, 0.5, 0.5]);
  const second = {
    ...row,
    operation: "write",
    referenceMs: row.referenceMs.map(() => 10000),
    samplesMs: row.samplesMs.map(() => 20000),
  };
  p.rows.push(second);
  for (const run of p.runs) run.rows.push(second);
  const metric = pairedSummary([p], p, [{ id: "overall", includes: () => true }])[0];
  expect(metric.workloads).toBe(2);
  expect(metric.points[0].value).toBeCloseTo(100);
  expect(metric.points[0].status).toBe("uncertain");
});

it("requires regression review even when the overall interval establishes an improvement", () => {
  const p = { ...point([1.01, 1.3, 1]), commitHash: "candidate" };
  for (let index = 0; index < 7; index++) {
    const faster = {
      ...row,
      operation: `control-${index}`,
      samplesMs: row.samplesMs.map(() => 50),
    };
    p.rows.push(faster);
    for (const run of p.runs) run.rows.push(faster);
  }
  const directory = mkdtempSync(join(tmpdir(), "vfs-paired-gate-"));
  try {
    const input = join(directory, "result.json");
    writeFileSync(input, JSON.stringify({ result: p, history: [p] }));
    const execution = spawnSync(process.execPath, ["bench/assess-paired.mjs", input], {
      encoding: "utf8",
    });
    expect(execution.stderr).toBe("");
    expect(JSON.parse(execution.stdout)).toMatchObject({
      conclusion: "faster",
      regressions: 0,
      review: 1,
    });
    expect(execution.status).toBe(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
