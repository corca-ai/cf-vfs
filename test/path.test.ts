import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "../src/core/glob.js";
import { normalizePath, normalizePathPreservingTrailingSlash } from "../src/core/path.js";

describe("path normalization", () => {
  it("resolves relative segments without escaping the virtual root", () => {
    expect(normalizePath("../logs/./app.log", "/repo/work")).toBe("/repo/logs/app.log");
    expect(normalizePath("../../../rooted", "/repo")).toBe("/rooted");
  });

  it("preserves directory intent only when requested", () => {
    expect(normalizePath("//repo///logs/")).toBe("/repo/logs");
    expect(normalizePathPreservingTrailingSlash("//repo///logs/")).toBe("/repo/logs/");
    expect(normalizePathPreservingTrailingSlash("/")).toBe("/");
  });

  it("enforces component limits in UTF-8 bytes", () => {
    expect(() => normalizePath(`/${"a".repeat(256)}`)).toThrowError(
      expect.objectContaining({ code: "ENAMETOOLONG" }),
    );
    expect(() => normalizePath(`/${"가".repeat(86)}`)).toThrowError(
      expect.objectContaining({ code: "ENAMETOOLONG" }),
    );
  });

  it("rejects NUL bytes", () => {
    expect(() => normalizePath("/before\0after")).toThrowError(
      expect.objectContaining({ code: "EINVAL", path: "/before\0after" }),
    );
  });
});

describe("glob bracket expressions", () => {
  it("handles leading closing brackets, negation, and descending ranges safely", () => {
    expect(matchesGlob("]", "[]a]")).toBe(true);
    expect(matchesGlob("a", "[]a]")).toBe(true);
    expect(matchesGlob("]", "[!]]")).toBe(false);
    expect(matchesGlob("a", "[!]]")).toBe(true);
    expect(matchesGlob("a", "[z-a]")).toBe(false);
    expect(matchesGlob("z", "[z-a]")).toBe(false);
    expect(matchesGlob("c", "[z-ac]")).toBe(true);
    expect(() => globToRegExp("[z-a]")).not.toThrow();
  });
});

it.each([
  ["**", "", true],
  ["**", "a/b", false],
  ["*a*a", "aaa", true],
  ["a**b*c", "abbc", true],
  ["*?*😀", "x😀", true],
  ["*\\**", "abc*xyz", true],
  ["*a*b", "a/b", false],
  ["*a*b", "ab", true],
] as const)("preserves star matching for %s against %s", (pattern, value, expected) => {
  expect(matchesGlob(value, pattern)).toBe(expected);
});
it("refuses oversized glob patterns before compiling them", () => {
  expect(() => globToRegExp("*".repeat(16_385))).toThrowError(
    expect.objectContaining({ code: "E2BIG" }),
  );
});
