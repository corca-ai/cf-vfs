import { describe, expect, it } from "vitest";
import { createLineDiff, renderLineDiff } from "../src/core/line-diff.js";
import { applyUnifiedPatch } from "../src/core/unified-patch.js";

describe("line diff", () => {
  it("renders changed unterminated lines without losing newline state", () => {
    const diff = createLineDiff("old", "new");

    expect(diff.changes).toBe(2);
    expect(renderLineDiff("/before", "/after", diff)).toBe(
      "--- /before\n" +
        "+++ /after\n" +
        "@@ -1,1 +1,1 @@\n" +
        "-old\n" +
        "\\ No newline at end of file\n" +
        "+new\n" +
        "\\ No newline at end of file\n",
    );
  });

  it("does not render a hunk when every line is equal", () => {
    const diff = createLineDiff("same\n", "same\n");

    expect(diff.changes).toBe(0);
    expect(renderLineDiff("/before", "/after", diff)).toBe("");
  });

  it("renders separated changes as independently positioned hunks", () => {
    const diff = createLineDiff("alpha\nkeep\nomega\n", "ALPHA\nkeep\nOMEGA\n");

    expect(diff.changes).toBe(4);
    expect(renderLineDiff("/before", "/after", diff)).toBe(
      "--- /before\n" +
        "+++ /after\n" +
        "@@ -1,1 +1,1 @@\n" +
        "-alpha\n" +
        "+ALPHA\n" +
        "@@ -3,1 +3,1 @@\n" +
        "-omega\n" +
        "+OMEGA\n",
    );
  });

  it.each([
    { name: "insertion into an empty file", before: "", after: "first\nsecond\n" },
    { name: "deletion to an empty file", before: "first\nsecond\n", after: "" },
    { name: "changes separated by retained lines", before: "a\nb\nc\n", after: "A\nb\nC\n" },
    { name: "unterminated final line", before: "one\ntwo", after: "one\nTWO" },
    { name: "CRLF line endings", before: "one\r\ntwo\r\n", after: "one\r\nTWO\r\n" },
  ])("renders a patch that round-trips $name", ({ before, after }) => {
    const patch = renderLineDiff("/before", "/after", createLineDiff(before, after));

    expect(applyUnifiedPatch(before, patch).text).toBe(after);
  });

  it("bounds the LCS matrix before allocating it", () => {
    const before = "before\n".repeat(1000);
    const after = "after\n".repeat(1000);

    expect(() => createLineDiff(before, after)).toThrowError(/comparison cells; limit is 1000000/);
  });
});
