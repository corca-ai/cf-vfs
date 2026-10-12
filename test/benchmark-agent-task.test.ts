import { expect, it } from "vitest";
import { AgentTask } from "../demo/benchmark-agent-task.js";
import { mergeRows } from "../demo/benchmark-protocol.js";
import type { BenchmarkRow } from "../demo/benchmark-store.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

// Two complete 1,000-file fixtures exceed Vitest's 5s default on shared CI.
it("executes distinct permission-bound coding cycles with matching commits and all bodies verified", async () => {
  const first = new AgentTask(createTestFileSystem());
  const second = new AgentTask(createTestFileSystem());
  await first.prepare();
  await second.prepare();
  const initial = await first.cycle();
  expect(await second.cycle()).toEqual(initial);
  expect(await first.validate()).toBe(1001);
  const next = await first.cycle();
  expect(next.at(-1)).not.toEqual(initial.at(-1));
  expect(await second.cycle()).toEqual(next);
  expect(await first.validate()).toBe(1001);
  expect(await second.validate()).toBe(1001);
}, 20_000);

it("fails the coding task when the editing principal loses access", async () => {
  const fs = createTestFileSystem();
  const task = new AgentTask(fs);
  await task.prepare();
  await task.cycle();
  fs.setMetadata("/repo/src/d0/f0.txt", { mode: 0o100000 });
  await expect(task.cycle()).rejects.toThrow("Agent task failed");
});

it("keeps every paired SQL sample separate from timing samples", () => {
  const cost = { statements: 5, rowsRead: 10, rowsWritten: 2 };
  const row: BenchmarkRow = {
    group: "agent-task",
    operation: "cycle",
    files: 1000,
    cache: false,
    iterations: 1,
    samplesMs: [42],
    referenceMs: [50],
    medianMs: 42,
    minMs: 42,
    maxMs: 42,
    costs: { reference: [cost], candidate: [{ ...cost, statements: 4 }] },
  };
  const result = mergeRows([row], [row])[0];
  expect(result?.samplesMs).toEqual([42, 42]);
  expect(result?.costs?.reference).toEqual([cost, cost]);
  expect(result?.costs?.candidate.map((sample) => sample.statements)).toEqual([4, 4]);
});
