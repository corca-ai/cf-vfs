import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import { splitLines } from "./helpers.js";

export function checkedTextLines(
  text: string,
  maximumRecords: number,
  maximumLineBytes: number,
): string[] {
  const lines = splitLines(text);
  if (lines.length > maximumRecords) throw new VfsError("E2BIG", "buffered record limit exceeded");
  for (const line of lines) {
    if (utf8ByteLength(line) > maximumLineBytes) {
      throw new VfsError("E2BIG", "line byte limit exceeded");
    }
  }
  return lines;
}
