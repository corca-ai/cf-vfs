import { expect, it } from "vitest";
import { benchmarkGroups } from "../demo/benchmark-protocol.js";
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

it("retains ten distinct commits across resets and replaces reruns without losing older commits", async () => {
  const { fs, store, result, advance, now } = fixture();
  for (let commit = 0; commit < 12; commit++) {
    const claim = await store.claim(true);
    if (claim.runId === null) throw new Error("No run");
    await store.complete({
      ...result(claim.runId),
      commitHash: `commit-${commit}`,
      buildId: `build-${commit}`,
    });
    advance(1000);
  }
  const reopened = new BenchmarkStore(fs, now);
  const before = (await reopened.get()).history.map((point) => point.commitHash);
  expect(before).toEqual(Array.from({ length: 10 }, (_, index) => `commit-${index + 2}`));
  for (let repeat = 0; repeat < 22; repeat++) {
    const claim = await reopened.claim(true);
    if (claim.runId === null) throw new Error("No run");
    await reopened.complete({
      ...result(claim.runId),
      commitHash: "commit-11",
      buildId: `rebuilt-${repeat}`,
      rows: [
        {
          group: "files",
          operation: "read",
          files: 100,
          cache: false,
          iterations: 100,
          samplesMs: [repeat],
          medianMs: repeat,
          minMs: repeat,
          maxMs: repeat,
        },
      ],
    });
    advance(1000);
  }
  const saved = await new BenchmarkStore(fs, now).get();
  expect(saved.history.map((point) => point.commitHash)).toEqual(before);
  expect(saved.history.at(-1)?.rows[0]?.medianMs).toBe(21);
  expect(saved.history.at(-1)).toMatchObject({ engine: "test", measurement: "test" });
});

it("recovers identifiable legacy runs without inventing commit hashes or duplicate builds", async () => {
  const { fs, store, result, advance } = fixture();
  fs.mkdir("/benchmarks/history", true);
  for (const [runId, buildId] of [
    ["a", "old"],
    ["b", "old"],
    ["c", "new"],
  ]) {
    await fs.writeFile(
      `/benchmarks/history/${runId}.json`,
      JSON.stringify({ ...result(runId ?? "missing"), buildId }),
    );
    advance(1000);
  }
  await fs.writeFile(RESULT_PATH, JSON.stringify({ ...result("c"), buildId: "new" }));
  const snapshot = await store.get();
  expect(snapshot.history.map((point) => point.buildId)).toEqual(["old", "new"]);
  expect(snapshot.history.every((point) => point.commitHash === undefined)).toBe(true);
  const claim = await store.claim(true);
  if (claim.runId === null) throw new Error("No run");
  await store.complete({ ...result(claim.runId), commitHash: "known", buildId: "new" });
  expect((await store.get()).history.map((point) => point.commitHash ?? point.buildId)).toEqual([
    "old",
    "known",
  ]);
});

// Keep dependent operations together, with the same fresh group fixtures used on CF.
// The full 100-file plan exceeds the default per-test timeout on shared CI runners.
const realOperationGroups = benchmarkGroups()
  .filter((stages) => stages[0]?.files === 100)
  .map((stages) => ({ group: stages[0]?.group, cache: stages[0]?.cache, stages }));
it.each(realOperationGroups)(
  "runs and validates $group operations (cache=$cache)",
  async ({ stages }) => {
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
    for (const stage of stages) {
      await suite.run(stage);
      const expected = validations.get(`${stage.group}/${stage.operation}`);
      if (expected !== undefined) expect(await suite.validate(stage)).toBe(expected);
    }
  },
);

// Validate all dependent operations on shared CI; performance has separate gates.
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
}, 20_000);

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

function pairedResult(runId: string, value: number): PublicBenchmarkResult {
  return {
    version: 2,
    runId,
    commitHash: "paired-commit",
    buildId: "same-build",
    completedAt: "fixed",
    colo: null,
    engine: "test",
    measurement: "paired-test",
    verified: 1,
    protocol: {
      id: "paired-test",
      referenceCommit: "reference",
      referenceHash: "hash",
      pairsPerRun: 2,
      warmupPairs: 1,
      credentials: "unbound",
    },
    rows: [
      {
        group: "files",
        operation: "read",
        files: 100,
        cache: false,
        iterations: 100,
        samplesMs: [value, value],
        referenceMs: [10, 10],
        medianMs: value,
        minMs: value,
        maxMs: value,
      },
    ],
  };
}
it("accumulates same-commit raw pairs durably without recounting reads or replacing them with the last run", async () => {
  const { store, fs, now } = fixture();
  for (const value of [8, 12]) {
    const claim = await store.claim(true);
    if (!claim.runId) throw new Error("No run");
    await store.complete(pairedResult(claim.runId, value));
    await store.get();
    await store.get();
  }
  const index = await new Response(fs.readFile("/benchmarks/trends.json").stream).json();
  expect(index).toEqual([expect.not.objectContaining({ runs: expect.anything() })]);
  expect(fs.list("/benchmarks/observations")).toHaveLength(1);
  expect((await store.get(false)).history).toEqual([]);
  const state = await new BenchmarkStore(fs, now).get();
  expect(state.history).toHaveLength(1);
  expect(state.history[0]).toMatchObject({ totalRuns: 2, rows: [{ medianMs: 10 }] });
  expect(state.history[0]?.runs?.map((r) => r.rows[0]?.samplesMs)).toEqual([
    [8, 8],
    [12, 12],
  ]);
});
it("bounds retained raw observations per commit and records how many runs were collected", async () => {
  const { store } = fixture();
  for (let value = 1; value <= 15; value++) {
    const claim = await store.claim(true);
    if (!claim.runId) throw new Error("No run");
    await store.complete(pairedResult(claim.runId, value));
  }
  const point = (await store.get()).history[0];
  expect(point?.totalRuns).toBe(15);
  expect(point?.runs).toHaveLength(12);
  expect(point?.rows[0]?.medianMs).toBe(9.5);
});
it("rejects malformed pairs and cohort/build mismatches before publishing", async () => {
  const { store } = fixture();
  const first = await store.claim(true);
  if (!first.runId) throw new Error("No run");
  await store.complete(pairedResult(first.runId, 10));
  const next = await store.claim(true);
  if (!next.runId) throw new Error("No run");
  const bad = pairedResult(next.runId, 8);
  const badRow = bad.rows[0];
  if (!badRow) throw new Error("No workload");
  badRow.referenceMs = [10];
  await expect(store.complete(bad)).rejects.toThrow("Invalid paired");
  await expect(
    store.complete({ ...pairedResult(next.runId, 8), buildId: "different" }),
  ).rejects.toThrow("different implementations");
  const changed = pairedResult(next.runId, 8);
  const changedRow = changed.rows[0];
  if (!changedRow) throw new Error("No workload");
  changedRow.iterations = 200;
  await expect(store.complete(changed)).rejects.toThrow("cohort changed");
  expect((await store.get()).result?.runId).toBe(first.runId);
});
