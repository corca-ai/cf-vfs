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

// String runs must retain JSON's exact escape and byte-offset semantics.
describe("JSON string boundaries", () => {
  it.each([
    "",
    "ordinary project path ".repeat(500),
    '한글😀\\path"quoted"\n\t\r\b\f',
    "\u0000\u001f\u007f",
  ])("round-trips text and adjacent object members", (text) => {
    const input = `{"value":${JSON.stringify(text)},"next":"end"}`;
    const value = parseJsonText(input, "jq");
    expect(value).toEqual(
      new Map([
        ["value", text],
        ["next", "end"],
      ]),
    );
    expect(JSON.parse(renderJson(value))).toEqual({ value: text, next: "end" });
  });
  it("decodes escaped slash, surrogate pairs and controls across adjacent strings", () => {
    const value = parseJsonText(String.raw`["a\/b","\uD83D\uDE00","\u0000","\"end"]`, "jq");
    expect(value).toEqual(["a/b", "😀", "\0", '"end']);
    expect(JSON.parse(renderJson(value))).toEqual(value);
  });
  it.each([
    ['"한글\u0001"', "unescaped control character at byte 7"],
    ['"é\\x"', "invalid escape at byte 3"],
    ['"é', "unterminated string at byte 3"],
    ['"é\\u00xz"', "invalid unicode escape at byte 3"],
  ])("reports the original invalid character in %s", (input, message) => {
    expect(() => parseJsonText(input, "jq")).toThrowError(`jq: ${message}`);
  });
});
