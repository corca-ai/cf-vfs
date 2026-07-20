import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue, inputRecord, integerValue } from "../core/validation.js";
import { commandText, joinLogicalLines, splitLogicalLines } from "./text-input.js";

export interface FoldInput {
  text: string;
  width?: number;
  spaces?: boolean;
}

function foldLine(line: string, width: number, spaces: boolean): string[] {
  const remaining = [...line];
  const output: string[] = [];
  while (remaining.length > width) {
    let take = width;
    if (spaces) {
      for (let index = width - 1; index >= 0; index -= 1) {
        if (/\s/u.test(remaining[index] ?? "")) {
          take = index + 1;
          break;
        }
      }
    }
    output.push(remaining.splice(0, take).join(""));
  }
  output.push(remaining.join(""));
  return output;
}

export async function runFold(
  _context: CommandContext,
  input: FoldInput,
): Promise<CommandPayload<{ inputLines: number; outputLines: number }>> {
  const logical = splitLogicalLines(input.text);
  const width = input.width ?? 80;
  const lines = logical.lines.flatMap((line) => foldLine(line, width, input.spaces ?? false));
  return {
    stdout: joinLogicalLines({ lines, finalNewline: logical.finalNewline }),
    data: { inputLines: logical.lines.length, outputLines: lines.length },
  };
}

export const foldCommand: CommandDefinition = {
  name: "fold",
  execute(context, input) {
    const record = inputRecord(input);
    return runFold(context, {
      text: commandText(context, record),
      width: integerValue(record, "width", 80, 1, 1_000_000),
      spaces: booleanValue(record, "spaces"),
    });
  },
};
