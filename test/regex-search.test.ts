import { expect, it } from "vitest";
import { compilePosixRegex } from "../src/core/posix-regex.js";

it.each([
  ["needle", "extended", "xxneedleneedle", 3, 8, "needle"],
  ["[x]y{2}", "extended", "axyyp", 0, 1, "xyy"],
  ["a+", "basic", "aa a+", 0, 3, "a+"],
  ["a\\+", "extended", "aa a+", 0, 3, "a+"],
  ["😀x", "extended", "😀x😀x", 1, 3, "😀x"],
  ["", "extended", "😀x", 1, 2, ""],
  ["x", "extended", "😀x", Number.NaN, 2, "x"],
] as const)("finds %s using parsed %s semantics", (pattern, dialect, text, from, index, match) => {
  expect(compilePosixRegex(pattern, dialect, "test").exec(text, from)).toEqual({
    index,
    end: index + match.length,
    groups: [match],
  });
});

it("never finds an isolated surrogate inside a paired code point", () => {
  for (const unit of ["\ud83d", "\ude00"]) {
    const pattern = compilePosixRegex(unit, "extended", "test");
    expect(pattern.exec("😀")).toBeUndefined();
    expect(pattern.test("😀")).toBe(false);
    expect(pattern.exec(`😀${unit}`)).toEqual({ index: 2, end: 3, groups: [unit] });
  }
});

it("preserves bounds and end-of-input searches for exact strings", () => {
  const pattern = compilePosixRegex("", "extended", "test");
  expect(pattern.exec("x", 1)).toEqual({ index: 1, end: 1, groups: [""] });
  expect(pattern.exec("x", 2)).toBeUndefined();
  expect(pattern.exec("x", Number.POSITIVE_INFINITY)).toBeUndefined();
  expect(compilePosixRegex("x", "extended", "test").exec("x", 0.5)).toBeUndefined();
  expect(() => compilePosixRegex("x{2048}", "extended", "test")).toThrow(/too complex/u);
});

it.each([
  "",
  "needle",
  "[x]",
  "a+",
  "(a|ab)",
  "(a*)*",
  "^([a-z]+[0-9]+)+$",
  "(😀|x)+",
  "[^a]+$",
  "a*b",
  "(a)?(b)?",
  "^$",
  "[[:alpha:]]+",
  "k",
])("agrees on boolean and capturing searches for %s", (source) => {
  for (const ignoreCase of [false, true]) {
    const pattern = compilePosixRegex(source, "extended", "test", { ignoreCase });
    for (const text of [
      "",
      "ab",
      "abab",
      "xxneedle",
      "ABC123",
      "a1b2",
      "😀x",
      "\ud83d",
      "K",
      "K",
    ]) {
      expect(pattern.test(text), JSON.stringify({ source, text, ignoreCase })).toBe(
        pattern.exec(text) !== undefined,
      );
    }
  }
});
