import { expect, it } from "vitest";
// @ts-expect-error The CLI's JavaScript helper has no declaration output.
import { comparePublicResults } from "../bench/public-comparison.mjs";

const row = {
  group: "git",
  operation: "add-all",
  files: 1000,
  cache: false,
  iterations: 1,
  medianMs: 100,
};
const baseline = { engine: "isomorphic-git 1.43.1", measurement: "RPC wall time", rows: [row] };

it("matches workload identities regardless of order and preserves each observed timing", () => {
  const other = { ...row, operation: "add-one" };
  const next = { ...row, medianMs: 50 };
  const pairs = comparePublicResults(
    { ...baseline, rows: [row, other] },
    { ...baseline, rows: [other, next] },
  );
  expect(pairs).toEqual([
    { row: other, previous: other },
    { row: next, previous: row },
  ]);
});

it("requires an explicit opt-in to add workloads and gives added rows no fabricated baseline", () => {
  const extra = { ...row, group: "git-shell" };
  const candidate = { ...baseline, rows: [row, extra] };
  expect(() => comparePublicResults(baseline, candidate)).toThrow("differs");
  expect(comparePublicResults(baseline, candidate, true)).toEqual([
    { row, previous: row },
    { row: extra, previous: undefined },
  ]);
});

it("rejects removed, changed and duplicated workloads even when additions are permitted", () => {
  expect(() => comparePublicResults(baseline, { ...baseline, rows: [] }, true)).toThrow("missing");
  expect(() =>
    comparePublicResults(baseline, { ...baseline, rows: [{ ...row, iterations: 1000 }] }, true),
  ).toThrow("row differs");
  expect(() => comparePublicResults(baseline, { ...baseline, rows: [row, row] }, true)).toThrow(
    "Duplicate",
  );
  expect(() => comparePublicResults({ ...baseline, rows: [row, row] }, baseline, true)).toThrow(
    "Duplicate",
  );
});

it("rejects different engines and measurement protocols", () => {
  expect(() => comparePublicResults(baseline, { ...baseline, engine: "other" }, true)).toThrow(
    "differs",
  );
  expect(() =>
    comparePublicResults(baseline, { ...baseline, measurement: "CPU time" }, true),
  ).toThrow("differs");
});
