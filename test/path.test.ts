import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "../src/core/glob.js";
import {
  compareUtf8,
  normalizePath,
  normalizePathPreservingTrailingSlash,
} from "../src/core/path.js";

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

it("normalizes canonical ASCII boundaries without relaxing pathname validation", () => {
  expect(normalizePath(`/a/${"b".repeat(250)}`)).toBe(`/a/${"b".repeat(250)}`);
  expect(normalizePath("/.git/objects/ab/hash")).toBe("/.git/objects/ab/hash");
  expect(normalizePath("/a\n/b\t")).toBe("/a\n/b\t");
  expect(normalizePath("/a/../b//./c/")).toBe("/b/c");
  expect(normalizePath("/가/😀/file")).toBe("/가/😀/file");
  expect(() => normalizePath(`/a/${"x".repeat(256)}`)).toThrowError(
    expect.objectContaining({ code: "ENAMETOOLONG" }),
  );
  expect(() => normalizePath("/a/\0b")).toThrowError(expect.objectContaining({ code: "EINVAL" }));
});

describe("UTF-8 ordering", () => {
  it("matches encoded byte order for prefixes, Unicode and malformed surrogates", () => {
    const values = [
      "",
      "a",
      "aa",
      "a\0",
      "a\n",
      "z",
      "é",
      "한글",
      "\u07ff",
      "\u0800",
      "\ud7ff",
      "\ue000",
      "\ufffd",
      "\uffff",
      "𐀀",
      "😀",
      "\u{10ffff}",
      "\ud800",
      "\udfff",
      "\ud800a",
      "a\ud800",
      "\ud800\ud800",
      "\udc00\ud800",
      "prefix😀",
      "prefix\ue000",
      "prefix\ud800suffix",
      "prefix\ufffdsuffix",
    ];
    const encoder = new TextEncoder();
    const cases = values.flatMap((value) => [value, `${"p".repeat(128)}${value}`]);
    for (const left of cases) {
      for (const right of cases) {
        const expected = encodedOrder(encoder.encode(left), encoder.encode(right));
        expect(Math.sign(compareUtf8(left, right)), JSON.stringify([left, right])).toBe(
          Math.sign(expected),
        );
      }
    }
  });
});

function encodedOrder(left: Uint8Array, right: Uint8Array): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = (left[i] ?? 0) - (right[i] ?? 0);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}
