import { describe, expect, it } from "vitest";
import { applyUnifiedPatch } from "../src/core/unified-patch.js";

describe("unified patch application", () => {
  it("preserves an unterminated replacement line", () => {
    const result = applyUnifiedPatch(
      "old",
      "--- before\n"
      + "+++ after\n"
      + "@@ -1,1 +1,1 @@\n"
      + "-old\n"
      + "\\ No newline at end of file\n"
      + "+new\n"
      + "\\ No newline at end of file\n",
    );

    expect(result).toEqual({
      text: "new",
      hunks: 1,
      additions: 1,
      deletions: 1,
    });
  });

  it("rejects a hunk whose context does not match the source", () => {
    expect(() => applyUnifiedPatch(
      "actual\n",
      "--- before\n+++ after\n@@ -1,1 +1,1 @@\n-expected\n+new\n",
    )).toThrowError(expect.objectContaining({ code: "EREVISION" }));
  });
});
