import { describe, expect, it } from "vitest";
import {
  compareJson,
  equalJson,
  JsonNumber,
  type JsonValue,
  parseJsonText,
  renderJson,
} from "../src/core/json-value.js";

describe("jq JSON values", () => {
  it("defines one antisymmetric total order across every JSON kind", () => {
    const ordered: ReadonlyArray<{ readonly name: string; readonly value: JsonValue }> = [
      { name: "null", value: null },
      { name: "false", value: false },
      { name: "true", value: true },
      { name: "number", value: new JsonNumber(-1, "-1") },
      { name: "string", value: "" },
      { name: "array", value: [] },
      { name: "object", value: new Map() },
    ];

    for (const [leftIndex, left] of ordered.entries()) {
      for (const [rightIndex, right] of ordered.entries()) {
        expect(
          Math.sign(compareJson(left.value, right.value)),
          `${left.name} vs ${right.name}`,
        ).toBe(Math.sign(leftIndex - rightIndex));
      }
    }
  });

  it("orders strings by UTF-8 bytes across the BMP boundary", () => {
    expect(compareJson("\ue000", "\u{10000}")).toBeLessThan(0);
    expect(compareJson("\u{10000}", "\ue000")).toBeGreaterThan(0);
  });

  it("compares arrays lexicographically and objects independently of insertion order", () => {
    expect(compareJson([1], [1, null])).toBeLessThan(0);
    expect(compareJson([1, 3], [1, 2])).toBeGreaterThan(0);

    const left = new Map<string, JsonValue>([
      ["b", 2],
      ["a", new JsonNumber(1, "1.0")],
    ]);
    const right = new Map<string, JsonValue>([
      ["a", 1],
      ["b", 2],
    ]);
    expect(equalJson(left, right)).toBe(true);
  });

  it("preserves member position and number spelling without mutating key order", () => {
    const value = parseJsonText('{"2":1.0,"1":2.50,"2":3}', "jq");
    expect(renderJson(value)).toBe('{"2":3,"1":2.50}');
    expect(renderJson(value, { sortKeys: true })).toBe('{"1":2.50,"2":3}');
    expect(renderJson(value)).toBe('{"2":3,"1":2.50}');
  });

  it("rejects sparse arrays instead of emitting malformed JSON", () => {
    const sparse: JsonValue[] = new Array(1);
    expect(() => renderJson(sparse)).toThrowError("invalid JsonValue");
    expect(() => compareJson(sparse, [null])).toThrowError("invalid JsonValue");
  });

  it("reports syntax offsets in UTF-8 bytes", () => {
    expect(() => parseJsonText('"é"x', "jq")).toThrowError("jq: invalid JSON at byte 4");
  });
});
