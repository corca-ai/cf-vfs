import { expect, it } from "vitest";
import {
  BENCHMARK_TTL_MS,
  BenchmarkStore,
  type PublicBenchmarkResult,
  RESULT_PATH,
} from "../demo/benchmark-store.js";
import { benchmarkPlan, PublicBenchmarkSuite } from "../demo/benchmark-suite.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

function fixture() {
  let clock = 1700000000000;
  const fs = createTestFileSystem({ now: () => clock });
  const store = new BenchmarkStore(fs, () => clock);
  const result = (runId: string): PublicBenchmarkResult => ({
    version: 1,
    runId,
    completedAt: "ignored for freshness",
    colo: null,
    engine: "test",
    measurement: "test",
    rows: [],
    verified: 1,
  });
  return {
    fs,
    store,
    result,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

it("reads without executing and expires exactly ten minutes after the result file mtime", async () => {
  const { fs, store, result, advance } = fixture();
  expect((await store.get()).status).toBe("empty");
  const first = await store.claim();
  expect(first.runId).not.toBeNull();
  if (first.runId === null) throw new Error("No run");
  advance(1000);
  await store.complete(result(first.runId));
  expect((await store.get()).modifiedAt).toBe(fs.stat(RESULT_PATH).modifiedAtMs);
  advance(BENCHMARK_TTL_MS - 1);
  expect((await store.claim()).runId).toBeNull();
  advance(1);
  expect((await store.claim()).runId).not.toBeNull();
});

it("coalesces concurrent requests and reconstructs the lease and result after eviction", async () => {
  const { fs, store, result } = fixture();
  const claims = await Promise.all([store.claim(), store.claim(), store.claim()]);
  expect(claims.filter((claim) => claim.runId !== null)).toHaveLength(1);
  const reconstructed = new BenchmarkStore(fs, () => 1700000000000);
  expect((await reconstructed.claim()).runId).toBeNull();
  const runId = claims[0]?.runId;
  if (runId === undefined || runId === null) throw new Error("No run");
  await reconstructed.complete(result(runId));
  expect((await new BenchmarkStore(fs, () => 1700000000000).get()).result?.runId).toBe(runId);
});

it("keeps the saved result after failure and rejects stale completions", async () => {
  const { store, result, advance } = fixture();
  const first = await store.claim();
  if (first.runId === null) throw new Error("No run");
  await store.complete(result(first.runId));
  advance(BENCHMARK_TTL_MS);
  const next = await store.claim();
  if (next.runId === null) throw new Error("No run");
  await store.fail(next.runId, "failed");
  expect((await store.get()).result?.runId).toBe(first.runId);
  const third = await store.claim();
  expect(third.runId).not.toBeNull();
  await expect(store.complete(result(next.runId))).rejects.toThrow("no longer active");
});

it("recovers an expired run without letting its old owner publish", async () => {
  const { store, result, advance } = fixture();
  const first = await store.claim();
  if (first.runId === null) throw new Error("No run");
  advance(BENCHMARK_TTL_MS);
  expect((await store.get()).status).toBe("failed");
  const next = await store.claim();
  expect(next.runId).not.toBeNull();
  await expect(store.complete(result(first.runId))).rejects.toThrow("no longer active");
});

it("runs real file and Git operations and verifies the resulting bytes with both cache settings", async () => {
  let suite: PublicBenchmarkSuite | undefined;
  const fs = createTestFileSystem({ onEvent: (event) => suite?.onEvent(event) });
  suite = new PublicBenchmarkSuite(fs);
  const validations = new Map([
    ["files/remove-tree", 100],
    ["git/checkout-main", 100],
    ["git-shell/add-one", 1],
    ["git-shell/add-changed", 100],
    ["git-shell/add-removals", 203],
  ]);
  for (const stage of benchmarkPlan().filter((stage) => stage.files === 100 && stage.trial === 0)) {
    await suite.run(stage);
    const expected = validations.get(`${stage.group}/${stage.operation}`);
    if (expected !== undefined) expect(await suite.validate(stage)).toBe(expected);
  }
});

it("runs and validates the 1,000-file shell Git workflow", async () => {
  const fs = createTestFileSystem();
  const suite = new PublicBenchmarkSuite(fs);
  const stages = benchmarkPlan().filter(
    (stage) => stage.group === "git-shell" && stage.files === 1000 && stage.trial === 0,
  );
  expect(stages).toHaveLength(19);
  for (const stage of stages) {
    await suite.run(stage);
    if (stage.operation === "add-one") expect(await suite.validate(stage)).toBe(1);
    if (stage.operation === "add-changed") expect(await suite.validate(stage)).toBe(1000);
    if (stage.operation === "add-removals") expect(await suite.validate(stage)).toBe(2003);
  }
  await suite.cleanup();
});

it("persists checkpoints and renews a running job lease without touching the saved result", async () => {
  const { fs, store, advance, now } = fixture();
  const claim = await store.claim();
  if (claim.runId === null) throw new Error("No run");
  advance(4 * 60 * 1000);
  const job = { runId: claim.runId, nextIndex: 9, rows: [], verified: 100, colo: "ICN" };
  await store.checkpoint(job);
  const reconstructed = new BenchmarkStore(fs, now);
  expect(await reconstructed.job()).toEqual(job);
  advance(4 * 60 * 1000);
  expect((await reconstructed.claim()).runId).toBeNull();
  advance(2 * 60 * 1000);
  expect((await reconstructed.get()).status).toBe("failed");
  await expect(reconstructed.checkpoint(job)).rejects.toThrow("no longer active");
});

it("allows authenticated callers to bypass freshness while sharing active runs and retaining history", async () => {
  const { fs, store, result } = fixture();
  const first = await store.claim();
  if (first.runId === null) throw new Error("No run");
  await store.complete({ ...result(first.runId), deploymentId: "before" });
  expect((await store.claim()).runId).toBeNull();
  const second = await store.claim(true);
  if (second.runId === null) throw new Error("No run");
  expect((await store.claim(true)).runId).toBeNull();
  await store.complete({ ...result(second.runId), deploymentId: "after" });
  expect((await store.get()).result?.deploymentId).toBe("after");
  expect(fs.list("/benchmarks/history")).toHaveLength(2);
  expect(
    await new Response(fs.readFile(`/benchmarks/history/${first.runId}.json`).stream).json(),
  ).toMatchObject({ deploymentId: "before" });
});
