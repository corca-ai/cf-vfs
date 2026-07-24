import { describe, expect, it } from "vitest";
import { parseUtilityOptions } from "../src/shell/commands/options.js";

const OPTIONS = {
  short: {
    a: { name: "all" },
    b: { name: "bytes", argument: true },
  },
  long: {
    all: { name: "all" },
    bytes: { name: "bytes", argument: true },
  },
  oldStyleCount: "count",
} as const;

describe("utility option parsing", () => {
  it("preserves option order across clusters and attached or separate arguments", () => {
    expect(parseUtilityOptions(
      "sample",
      ["-ab12", "first", "--all", "--bytes=34", "-b", "56"],
      OPTIONS,
    )).toEqual({
      options: [
        { name: "all" },
        { name: "bytes", argument: "12" },
        { name: "all" },
        { name: "bytes", argument: "34" },
        { name: "bytes", argument: "56" },
      ],
      operands: ["first"],
    });
  });

  it("ends option parsing at -- and preserves a lone dash as an operand", () => {
    expect(parseUtilityOptions("sample", ["-", "--", "-a", "--bytes=1"], OPTIONS))
      .toEqual({
        options: [],
        operands: ["-", "-a", "--bytes=1"],
      });
  });

  it("supports the historical numeric count form without changing digit options generally", () => {
    expect(parseUtilityOptions("sample", ["-10"], OPTIONS)).toEqual({
      options: [{ name: "count", argument: "10" }],
      operands: [],
    });
    expect(() => parseUtilityOptions("sample", ["-1x"], OPTIONS))
      .toThrowError("sample: unsupported option -1");
  });

  it("identifies the exact unsupported member of a short-option cluster", () => {
    expect(() => parseUtilityOptions("sample", ["-az"], OPTIONS))
      .toThrowError("sample: unsupported option -z");
  });

  it("rejects missing and unexpected option arguments", () => {
    expect(() => parseUtilityOptions("sample", ["-b"], OPTIONS))
      .toThrowError("sample: option -b requires an argument");
    expect(() => parseUtilityOptions("sample", ["--all=value"], OPTIONS))
      .toThrowError("sample: option --all does not accept an argument");
  });
});
