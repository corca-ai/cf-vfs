import { expect, it } from "vitest";
import { createLineDiff, renderLineDiff } from "../src/core/line-diff.js";
import { applyUnifiedPatch } from "../src/core/unified-patch.js";

it.each([
  ["a\n", "a\nb\n", "@@ -1,0 +2,1 @@\n+b\n"],
  ["a\nb\n", "a\n", "@@ -2,1 +1,0 @@\n-b\n"],
  ["", "a\n", "@@ -0,0 +1,1 @@\n+a\n"],
  ["a\n", "", "@@ -1,1 +0,0 @@\n-a\n"],
])("uses unified-diff positions for empty ranges: %j to %j", (before, after, hunk) => {
  const patch = `--- a\n+++ b\n${hunk}`;
  expect(applyUnifiedPatch(before, patch).text).toBe(after);
  expect(renderLineDiff("a", "b", createLineDiff(before, after))).toBe(patch);
});

it("diffs and renders large insertions within the comparison-cell limit", () => {
  const after = "x\n".repeat(150_000);
  const patch = renderLineDiff("a", "b", createLineDiff("", after));
  expect(applyUnifiedPatch("", patch).text).toBe(after);
});

it("patches large unchanged prefixes and suffixes without argument-stack expansion", () => {
  const unchanged = "x\n".repeat(150_000);
  const source = `${unchanged}before\n${unchanged}`;
  const patch = "--- a\n+++ b\n@@ -150001,1 +150001,1 @@\n-before\n+after\n";
  expect(applyUnifiedPatch(source, patch).text).toBe(`${unchanged}after\n${unchanged}`);
});
