import { describe, expect, it } from "vitest";
import { createLineDiff, renderLineDiff } from "../src/core/line-diff.js";

describe("line diff", () => {
  it("renders changed unterminated lines without losing newline state", () => {
    const diff = createLineDiff("old", "new");

    expect(diff.changes).toBe(2);
    expect(renderLineDiff("/before", "/after", diff)).toBe(
      "--- /before\n"
      + "+++ /after\n"
      + "@@ -1,1 +1,1 @@\n"
      + "-old\n"
      + "\\ No newline at end of file\n"
      + "+new\n"
      + "\\ No newline at end of file\n",
    );
  });

  it("does not render a hunk when every line is equal", () => {
    const diff = createLineDiff("same\n", "same\n");

    expect(diff.changes).toBe(0);
    expect(renderLineDiff("/before", "/after", diff)).toBe("");
  });

  it("bounds the LCS matrix before allocating it", () => {
    const before = "before\n".repeat(1000);
    const after = "after\n".repeat(1000);

    expect(() => createLineDiff(before, after)).toThrowError(
      /comparison cells; limit is 1000000/,
    );
  });
});
