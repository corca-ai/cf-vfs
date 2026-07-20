import type { CommandContext } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import { optionalString } from "../core/validation.js";
import type { InputRecord } from "../core/validation.js";

export interface LogicalLines {
  lines: string[];
  finalNewline: boolean;
}

export function commandText(
  context: CommandContext,
  record: InputRecord,
): string {
  const text = optionalString(record, "text") ?? context.stdin;
  if (new TextEncoder().encode(text).byteLength > context.maxInputBytes) {
    throw new VfsError("E2BIG", `text exceeds the ${context.maxInputBytes}-byte input limit`);
  }
  return text;
}

export function boundedTextValues(
  context: CommandContext,
  values: readonly string[],
  name: string,
): string[] {
  const totalBytes = values.reduce(
    (total, value) => total + new TextEncoder().encode(value).byteLength,
    0,
  );
  if (totalBytes > context.maxInputBytes) {
    throw new VfsError(
      "E2BIG",
      `${name} exceed the ${context.maxInputBytes}-byte input limit`,
    );
  }
  return [...values];
}

export function splitLogicalLines(text: string): LogicalLines {
  if (text.length === 0) return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), finalNewline };
}

export function joinLogicalLines(value: LogicalLines): string {
  if (value.lines.length === 0) return "";
  return `${value.lines.join("\n")}${value.finalNewline ? "\n" : ""}`;
}
