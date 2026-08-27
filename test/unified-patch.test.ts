import { describe, expect, it } from "vitest";
import { applyUnifiedPatch } from "../src/core/unified-patch.js";

describe("unified patch application", () => {
  it("applies multiple hunks while preserving lines outside them", () => {
    const result = applyUnifiedPatch(
      "alpha\nkeep\nomega\ntail\n",
      "--- before\n" +
        "+++ after\n" +
        "@@ -1,1 +1,1 @@\n" +
        "-alpha\n" +
        "+ALPHA\n" +
        "@@ -3,1 +3,2 @@\n" +
        "-omega\n" +
        "+OMEGA\n" +
        "+extra\n",
    );

    expect(result).toEqual({
      text: "ALPHA\nkeep\nOMEGA\nextra\ntail\n",
      hunks: 2,
      additions: 3,
      deletions: 2,
    });
  });

  it.each([
    {
      name: "inserts into an empty file",
      source: "",
      patch: "--- before\n+++ after\n@@ -0,0 +1,2 @@\n+first\n+second\n",
      expected: "first\nsecond\n",
    },
    {
      name: "deletes the complete file",
      source: "first\nsecond\n",
      patch: "--- before\n+++ after\n@@ -1,2 +0,0 @@\n-first\n-second\n",
      expected: "",
    },
  ])("$name using a zero-length hunk range", ({ source, patch, expected }) => {
    expect(applyUnifiedPatch(source, patch).text).toBe(expected);
  });

  it("preserves an unterminated replacement line", () => {
    const result = applyUnifiedPatch(
      "old",
      "--- before\n" +
        "+++ after\n" +
        "@@ -1,1 +1,1 @@\n" +
        "-old\n" +
        "\\ No newline at end of file\n" +
        "+new\n" +
        "\\ No newline at end of file\n",
    );

    expect(result).toEqual({
      text: "new",
      hunks: 1,
      additions: 1,
      deletions: 1,
    });
  });

  it("rejects a hunk whose context does not match the source", () => {
    expect(() =>
      applyUnifiedPatch("actual\n", "--- before\n+++ after\n@@ -1,1 +1,1 @@\n-expected\n+new\n"),
    ).toThrowError(expect.objectContaining({ code: "EREVISION" }));
  });

  it.each([
    {
      name: "a missing final newline",
      patch: "--- before\n+++ after\n@@ -1 +1 @@\n value",
    },
    {
      name: "missing file headers",
      patch: "@@ -1 +1 @@\n value\n",
    },
    {
      name: "a patch with no hunks",
      patch: "--- before\n+++ after\n",
    },
    {
      name: "line counts that disagree with the hunk body",
      patch: "--- before\n+++ after\n@@ -1,2 +1,1 @@\n-value\n+VALUE\n",
    },
    {
      name: "a misplaced no-newline marker",
      patch: "--- before\n+++ after\n@@ -1 +1 @@\n\\ No newline at end of file\n",
    },
  ])("rejects $name as an invalid patch", ({ patch }) => {
    expect(() => applyUnifiedPatch("value\n", patch)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("rejects overlapping hunks before applying a partial result", () => {
    const patch =
      "--- before\n" +
      "+++ after\n" +
      "@@ -1 +1 @@\n" +
      "-one\n" +
      "+ONE\n" +
      "@@ -1 +1 @@\n" +
      "-one\n" +
      "+again\n";

    expect(() => applyUnifiedPatch("one\ntwo\n", patch)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("rejects a hunk whose new-file position is inconsistent", () => {
    expect(() =>
      applyUnifiedPatch("value\n", "--- before\n+++ after\n@@ -1 +2 @@\n-value\n+VALUE\n"),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });
});
