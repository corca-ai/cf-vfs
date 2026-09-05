import { expect, it } from "vitest";
import { compilePosixRegex } from "../src/core/posix-regex.js";
import { ExecutionBudget, resolveShellLimits } from "../src/shell/budget.js";
import { substitute } from "../src/shell/commands/sed-substitute.js";

function replacementCommand(replacement: string) {
  return {
    kind: "s" as const,
    pattern: compilePosixRegex("x", "basic", "sed"),
    replacement,
    global: false,
    print: false,
    occurrence: 0,
  };
}

it.each([{ maxExpansionChars: 32 }, { maxExpansionWork: 32 }, { maxBufferedBytes: 32 }])(
  "bounds a literal replacement with %j",
  (limits) => {
    const budget = new ExecutionBudget(resolveShellLimits(limits), () => 0);
    expect(() => substitute(replacementCommand("a".repeat(33)), "x", budget)).toThrow(/limit/u);
  },
);

it("counts literal replacement bytes alongside buffers already held by sed", () => {
  const budget = new ExecutionBudget(resolveShellLimits({ maxBufferedBytes: 32 }), () => 0);
  const release = budget.buffered(16);
  expect(() => substitute(replacementCommand("a".repeat(17)), "x", budget)).toThrow(/byte limit/u);
  release();
  expect(substitute(replacementCommand("a".repeat(17)), "x", budget).value).toBe("a".repeat(17));
});

it("counts whole UTF-8 characters in a literal replacement", () => {
  const budget = new ExecutionBudget(resolveShellLimits({ maxBufferedBytes: 4 }), () => 0);
  expect(substitute(replacementCommand("😀"), "x", budget)).toEqual({
    value: "😀",
    changed: true,
  });
});
