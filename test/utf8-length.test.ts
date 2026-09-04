import { expect, it } from "vitest";
import { utf8ByteLength } from "../src/core/unicode.js";

it.each(["", "hello", "\0\t\r\n\x7f", "é", "한글", "😀", "\ud800", "\udc00"])(
  "counts UTF-8 bytes consistently for %j around the short-string boundary",
  (value) => {
    const encoder = new TextEncoder();
    for (const padding of [0, 127, 128, 129, 8192]) {
      const text = `${"a".repeat(padding)}${value}`;
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).byteLength);
    }
  },
);
