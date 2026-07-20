import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue, inputRecord, integerValue, stringValue } from "../core/validation.js";
import { commandText, joinLogicalLines, splitLogicalLines } from "./text-input.js";

export interface NlInput {
  text: string;
  all?: boolean;
  start?: number;
  increment?: number;
  width?: number;
  separator?: string;
}

export async function runNl(
  _context: CommandContext,
  input: NlInput,
): Promise<CommandPayload<{ lines: number; numbered: number }>> {
  const logical = splitLogicalLines(input.text);
  const width = input.width ?? 6;
  const increment = input.increment ?? 1;
  const separator = input.separator ?? "\t";
  let number = input.start ?? 1;
  let numbered = 0;
  const lines = logical.lines.map((line) => {
    if (!input.all && line.length === 0) return `${" ".repeat(width)}${separator}${line}`;
    const prefix = number.toString().padStart(width);
    number += increment;
    numbered += 1;
    return `${prefix}${separator}${line}`;
  });
  return {
    stdout: joinLogicalLines({ lines, finalNewline: logical.finalNewline }),
    data: { lines: lines.length, numbered },
  };
}

export const nlCommand: CommandDefinition = {
  name: "nl",
  execute(context, input) {
    const record = inputRecord(input);
    return runNl(context, {
      text: commandText(context, record),
      all: booleanValue(record, "all"),
      start: integerValue(record, "start", 1, 0, Number.MAX_SAFE_INTEGER),
      increment: integerValue(record, "increment", 1, 1, Number.MAX_SAFE_INTEGER),
      width: integerValue(record, "width", 6, 1, 20),
      separator: stringValue(record, "separator", "\t"),
    });
  },
};
