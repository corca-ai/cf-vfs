import { describe, expect, it } from "vitest";
import { byteRangeBounds, validateByteRange } from "../src/vfs/range.js";
import type { ByteRange } from "../src/vfs/types.js";

describe("byte range normalization", () => {
  it.each<{
    readonly name: string;
    readonly range: ByteRange | undefined;
    readonly sizeBytes: number;
    readonly expected: { readonly offset: number; readonly length: number };
  }>([
    {
      name: "an absent range selects the whole body",
      range: undefined,
      sizeBytes: 12,
      expected: { offset: 0, length: 12 },
    },
    {
      name: "an offset selects through EOF",
      range: { offset: 5 },
      sizeBytes: 12,
      expected: { offset: 5, length: 7 },
    },
    {
      name: "a length selects from the start",
      range: { length: 5 },
      sizeBytes: 12,
      expected: { offset: 0, length: 5 },
    },
    {
      name: "an offset and length select their intersection with the body",
      range: { offset: 9, length: 10 },
      sizeBytes: 12,
      expected: { offset: 9, length: 3 },
    },
    {
      name: "an offset past EOF selects an empty range at EOF",
      range: { offset: 20 },
      sizeBytes: 12,
      expected: { offset: 12, length: 0 },
    },
    {
      name: "a suffix selects the tail",
      range: { suffix: 5 },
      sizeBytes: 12,
      expected: { offset: 7, length: 5 },
    },
    {
      name: "a suffix longer than the body selects the whole body",
      range: { suffix: 20 },
      sizeBytes: 12,
      expected: { offset: 0, length: 12 },
    },
    {
      name: "every valid range over an empty body stays empty",
      range: { suffix: 5 },
      sizeBytes: 0,
      expected: { offset: 0, length: 0 },
    },
  ])("$name", ({ range, sizeBytes, expected }) => {
    expect(byteRangeBounds(range, sizeBytes)).toEqual(expected);
  });

  it.each([
    { name: "a non-object", range: null, message: "byte range must be an object" },
    { name: "an empty object", range: {}, message: "byte range must use offset/length or suffix" },
    {
      name: "mixed prefix and suffix forms",
      range: { offset: 0, suffix: 1 },
      message: "byte range must use offset/length or suffix",
    },
    { name: "a zero length", range: { length: 0 }, message: "length must be a positive integer" },
    {
      name: "a negative offset",
      range: { offset: -1 },
      message: "offset must be a non-negative integer",
    },
    {
      name: "an unsafe integer",
      range: { offset: Number.MAX_SAFE_INTEGER + 1 },
      message: "offset must be a non-negative integer",
    },
    {
      name: "an unknown field",
      range: { suffix: 1, unexpected: true },
      message: "unknown byte range field: unexpected",
    },
  ])("rejects $name with a stable diagnostic", ({ range, message }) => {
    expect(() => validateByteRange(range, "/file.txt")).toThrowError(
      expect.objectContaining({ code: "EINVAL", path: "/file.txt", message }),
    );
  });

  it("does not treat prototype properties as range fields", () => {
    const range = Object.create({ suffix: 5 }) as unknown;

    expect(() => validateByteRange(range)).toThrowError(
      expect.objectContaining({
        code: "EINVAL",
        message: "byte range must use offset/length or suffix",
      }),
    );
  });
});
