import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue, inputRecord } from "../core/validation.js";
import { commandText, joinLogicalLines, splitLogicalLines } from "./text-input.js";

export interface SortInput {
  text: string;
  ignoreCase?: boolean;
  numeric?: boolean;
  reverse?: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function runSort(
  _context: CommandContext,
  input: SortInput,
): Promise<CommandPayload<{ lines: number }>> {
  const logical = splitLogicalLines(input.text);
  const decorated = logical.lines.map((line, index) => ({ line, index }));
  decorated.sort((left, right) => {
    let compared: number;
    if (input.numeric) {
      const leftNumber = Number(left.line.trim());
      const rightNumber = Number(right.line.trim());
      const leftKey = Number.isNaN(leftNumber) ? 0 : leftNumber;
      const rightKey = Number.isNaN(rightNumber) ? 0 : rightNumber;
      compared = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    } else {
      const leftKey = input.ignoreCase ? left.line.toLowerCase() : left.line;
      const rightKey = input.ignoreCase ? right.line.toLowerCase() : right.line;
      compared = compareText(leftKey, rightKey);
    }
    if (compared === 0) return left.index - right.index;
    return input.reverse ? -compared : compared;
  });
  return {
    stdout: joinLogicalLines({
      lines: decorated.map(({ line }) => line),
      finalNewline: logical.finalNewline,
    }),
    data: { lines: logical.lines.length },
  };
}

export const sortCommand: CommandDefinition = {
  name: "sort",
  execute(context, input) {
    const record = inputRecord(input);
    return runSort(context, {
      text: commandText(context, record),
      ignoreCase: booleanValue(record, "ignoreCase"),
      numeric: booleanValue(record, "numeric"),
      reverse: booleanValue(record, "reverse"),
    });
  },
};
