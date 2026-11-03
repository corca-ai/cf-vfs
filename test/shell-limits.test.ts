import { expect, it } from "vitest";
import {
  DEFAULT_SHELL_LIMITS,
  deriveShellLimits,
  resolveShellLimits,
} from "../src/shell/budget.js";
import { awkCommand } from "../src/shell/commands/awk.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import type { ShellEvent } from "../src/shell/events.js";
import { InteractiveInputBuffer } from "../src/shell/interactive.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellLimits } from "../src/shell/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("has five limits, accepts 0.5's names as the caps they named, and refuses others", () => {
  expect(Object.keys(DEFAULT_SHELL_LIMITS).sort()).toEqual([
    "deadlineMs",
    "maxDepth",
    "maxMemoryBytes",
    "maxRowsWritten",
    "maxWork",
  ]);
  const legacy = resolveShellLimits({ maxTotalIoBytes: 128, maxSteps: 7, maxBufferedBytes: 64 });
  expect(legacy).toMatchObject({ maxTotalIoBytes: 128, maxSteps: 7, maxBufferedBytes: 64 });
  expect(legacy.maxWork).toBe(DEFAULT_SHELL_LIMITS.maxWork);
  expect(() => resolveShellLimits({ maxWrok: 1 } as Partial<ShellLimits>)).toThrow(
    "maxWrok is not a shell limit",
  );
  expect(() => resolveShellLimits({ maxWork: 0 })).toThrow(
    "maxWork must be a positive safe integer",
  );
});

it("derives 0.5's caps at the default memory, and scales them with it", () => {
  const derived = resolveShellLimits();
  expect(derived).toMatchObject({
    maxLineBytes: 1024 * 1024,
    maxBufferedBytes: 16 * 1024 * 1024,
    maxBufferedRecords: 100_000,
    maxExpansionChars: 1024 * 1024,
    maxAstNodes: 10_000,
    maxGlobMatches: 65_536,
    maxNestingDepth: 64,
    maxSourceDepth: 16,
    maxScriptDepth: 8,
  });
  const quarter = deriveShellLimits({
    ...DEFAULT_SHELL_LIMITS,
    maxMemoryBytes: 4 * 1024 * 1024,
    maxDepth: 16,
  });
  expect(quarter).toMatchObject({
    maxLineBytes: 256 * 1024,
    maxBufferedRecords: 25_000,
    maxNestingDepth: 16,
    maxSourceDepth: 4,
    maxScriptDepth: 2,
  });
  // Work and writes have one bound each.
  expect(derived.maxSteps).toBe(Number.MAX_SAFE_INTEGER);
  expect(derived.maxReadBytes).toBe(Number.MAX_SAFE_INTEGER);
  expect(derived.maxMutations).toBe(Number.MAX_SAFE_INTEGER);
});

async function shell(limits: Partial<ShellLimits>, events: ShellEvent[] = [], policy = {}) {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/big", "word ".repeat(200_000));
  return new Shell({
    fileSystem,
    commands: [...defaultShellCommands, awkCommand],
    limits,
    policy,
    onEvent: (event) => events.push(event),
  });
}

it("names what spent the work when maxWork refuses", async () => {
  const events: ShellEvent[] = [];
  const reading = await shell({ maxWork: 20_000 }, events);
  const result = await reading.executeText({
    script: "for i in 1 2 3 4 5; do cat /big > /dev/null; done",
  });
  expect(result.stderr).toMatch(/^shell work limit exceeded \(file reads \d/u);
  const limit = events.find((event) => event.type === "shell.limit");
  expect(limit).toMatchObject({ limit: "maxWork", max: 20_000 });
  expect(limit?.type === "shell.limit" && limit.breakdown?.[0]?.consumer).toBe("file reads");
  const looping = await shell({ maxWork: 20_000 });
  expect((await looping.executeText({ script: "while :; do :; done" })).stderr).toMatch(
    /^shell work limit exceeded \(shell steps .*commands/u,
  );
});

it("bounds rows written, and lets a policy only tighten the bound", async () => {
  const writes = "i=0; while [ $i -lt 30 ]; do echo $i > /f$i; i=$((i+1)); done";
  const roomy = await shell({ maxRowsWritten: 200 });
  expect((await roomy.executeText({ script: writes })).exitCode).toBe(0);
  const tight = await shell({ maxRowsWritten: 100 });
  expect((await tight.executeText({ script: writes })).stderr).toContain(
    "shell row-write limit exceeded",
  );
  const policed = await shell({ maxRowsWritten: 200 }, [], { maxRowsWritten: 100 });
  expect((await policed.executeText({ script: writes })).stderr).toContain("row-write limit");
  const loose = await shell({ maxRowsWritten: 100 }, [], { maxRowsWritten: 1_000 });
  expect((await loose.executeText({ script: writes })).stderr).toContain("row-write limit");
});

it("parses pending input under the session's memory and depth", () => {
  const buffer = new InteractiveInputBuffer({
    limits: { maxMemoryBytes: 2 * 1024 * 1024, maxDepth: 32 },
  });
  expect(buffer.push("if true; then")).toEqual({ status: "incomplete" });
  expect(buffer.push("echo hi; fi")).toMatchObject({ status: "ready" });
});

it("refuses a name only an object's prototype has, before checking its value", () => {
  for (const name of ["toString", "constructor", "hasOwnProperty"]) {
    expect(() => resolveShellLimits({ [name]: 0 } as Partial<ShellLimits>)).toThrow(
      `${name} is not a shell limit`,
    );
  }
  expect(() => resolveShellLimits({ maxPipelineBytes: 9 * 1024 * 1024 })).toThrow(
    "maxPipelineBytes cannot exceed",
  );
});

it("reports buffered data refused by maxMemoryBytes under that name", async () => {
  const events: ShellEvent[] = [];
  const small = await shell({ maxMemoryBytes: 64 * 1024 }, events);
  // A second pipeline stage holds 96 KiB of buffered data.
  const result = await small.executeText({ script: "true | true" });
  expect(result.stderr).toContain("buffered-byte limit");
  expect(events.find((event) => event.type === "shell.limit")).toMatchObject({
    limit: "maxMemoryBytes",
  });
});

it("bounds function recursion by maxDepth", async () => {
  const shallow = await shell({ maxDepth: 8 });
  const result = await shallow.executeText({ script: "f() { f; }; f" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("function recursion limit");
});

it("charges a big file's chunks as rows, copies as reads, and output to /dev/null as work", async () => {
  const rows = await shell({ maxRowsWritten: 20 });
  // 8 MiB is 32 chunks: four rows for the entry and one more for each further chunk.
  expect(
    (
      await rows.executeText({
        script: "head -c 8388608 /big > /a 2>/dev/null; cat /big /big > /c",
      })
    ).exitCode,
  ).toBe(0);
  const copies = await shell({ maxRowsWritten: 50_000, maxWork: 40_000 });
  const copied = await copies.executeText({
    script: "for i in 1 2 3 4 5 6 7 8 9 10; do cp /big /copy; done",
  });
  expect(copied.stderr).toMatch(/^shell work limit exceeded \(file reads/u);
  const nulls = await shell({ maxWork: 40_000 });
  const discarded = await nulls.executeText({
    script: "for i in 1 2 3 4 5 6 7 8 9 10; do od -An -tx1 /big > /dev/null; done",
  });
  expect(discarded.stderr).toMatch(/^shell work limit exceeded \(pipes and output/u);
});

it("takes a 0.5 policy's maxMutations at four rows each", async () => {
  const writes = "i=0; while [ $i -lt 30 ]; do echo $i > /f$i; i=$((i+1)); done";
  const legacy = await shell({}, [], { maxMutations: 20 });
  expect((await legacy.executeText({ script: writes })).stderr).toContain("row-write limit");
});
