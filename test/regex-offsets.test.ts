import { expect, it } from "vitest";
import { compilePosixRegex } from "../src/core/posix-regex.js";

it.each([
  [0, 0, 1, "a"],
  [1, 1, 3, "😀"],
  [2, 3, 4, "b"],
  [2.5, 3, 4, "b"],
  [3, 3, 4, "b"],
  [4, 4, 6, "𐐀"],
  [5, 6, 7, "c"],
])("matches whole code points from UTF-16 offset %s", (from, index, end, group) => {
  const pattern = compilePosixRegex("(.)", "extended", "test");
  expect(pattern.exec("a😀b𐐀c", from)).toEqual({ index, end, groups: [group, group] });
});

it("preserves absolute anchors and empty matches after non-BMP text", () => {
  expect(compilePosixRegex("$", "extended", "test").exec("😀", 1)).toEqual({
    index: 2,
    end: 2,
    groups: [""],
  });
  expect(compilePosixRegex("^.", "extended", "test").exec("😀x", 2)).toBeUndefined();
  expect(compilePosixRegex("(.)?x", "extended", "test").exec("😀x")).toEqual({
    index: 0,
    end: 3,
    groups: ["😀x", "😀"],
  });
});

it("treats unpaired surrogates as individual code points", () => {
  const pattern = compilePosixRegex("(.)", "extended", "test");
  expect(pattern.exec("\ud800x\udc00", 2)).toEqual({
    index: 2,
    end: 3,
    groups: ["\udc00", "\udc00"],
  });
});
