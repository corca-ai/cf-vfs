import { expect, it } from "vitest";
// @ts-expect-error Shared static browser/CLI module has no declaration output.
import { assessPairs, geometricMean, summarizeHistory } from "../demo/public/benchmarks/summary.js";

const file = {
  group: "files",
  operation: "read",
  files: 100,
  cache: false,
  iterations: 100,
  medianMs: 10,
};
const git = { ...file, group: "git", operation: "add-all", iterations: 1, medianMs: 1000 };
const cached = { ...file, cache: true, medianMs: 5 };
const result = { engine: "git", measurement: "RPC", rows: [file, git, cached] };
const point = (rows: object[], commitHash: string) => ({
  rows,
  commitHash,
  completedAt: "2026-10-10",
});
it("uses equal workload ratios rather than mixing absolute milliseconds or cache variants", () => {
  const history = [
    point(result.rows, "a"),
    point([{ ...file, medianMs: 5 }, { ...git, medianMs: 2000 }, cached], "b"),
  ];
  const metrics = summarizeHistory(history, result);
  expect(metrics[0].regressions).toBe(1);
  expect(metrics[0].points.map((p: { value: number }) => p.value)).toEqual([100, 100]);
  expect(metrics[1].points[1].value).toBeCloseTo(50);
  expect(metrics[2].points[1].value).toBeCloseTo(200);
  expect(metrics[3].points[1].value).toBeCloseTo(100);
});
it("omits changed protocols and incomplete cohorts and excludes a zero workload across every point", () => {
  const history = [
    point(result.rows, "a"),
    point([file], "missing"),
    { ...point(result.rows, "wrong"), engine: "other" },
    point([{ ...file, medianMs: 0 }, git, cached], "b"),
  ];
  const metric = summarizeHistory(history, result)[0];
  expect(metric.skipped).toBe(2);
  expect(metric.workloads).toBe(1);
  expect(metric.excluded).toBe(1);
  expect(metric.points.map((p: { value: number }) => p.value)).toEqual([100, 100]);
  expect(summarizeHistory([], result)[0].points).toEqual([]);
  expect(() => summarizeHistory([point([file, file], "dup")], result)).toThrow("Duplicate");
});
it("flags individual regressions even when the overall mean improves", () => {
  const report = assessPairs([
    { previous: file, row: { ...file, medianMs: 2 } },
    { previous: git, row: { ...git, medianMs: 1100 } },
  ]);
  expect(report.metrics[0].ratio).toBeLessThan(1);
  expect(report.regressions).toHaveLength(1);
  expect(report.requiresReview).toBe(true);
});
it("never fabricates zero-time ratios and reports SQL costs independently", () => {
  const report = assessPairs([
    { previous: { ...file, sql: { statements: 1 } }, row: { ...file, sql: { statements: 2 } } },
    { previous: git, row: { ...git, medianMs: 0 } },
  ]);
  expect(report.unresolved).toHaveLength(1);
  expect(report.costRegressions).toHaveLength(1);
  expect(report.requiresReview).toBe(true);
  expect(geometricMean([])).toBeNull();
  expect(() => geometricMean([0])).toThrow("positive");
  expect(assessPairs([{ previous: file, row: file }]).requiresReview).toBe(false);
});
