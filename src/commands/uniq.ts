import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue, inputRecord } from "../core/validation.js";
import { commandText, joinLogicalLines, splitLogicalLines } from "./text-input.js";

export interface UniqInput {
  text: string;
  count?: boolean;
  ignoreCase?: boolean;
}

export async function runUniq(
  _context: CommandContext,
  input: UniqInput,
): Promise<CommandPayload<{ inputLines: number; outputLines: number }>> {
  const logical = splitLogicalLines(input.text);
  const output: string[] = [];
  let previousKey: string | undefined;
  let previousLine = "";
  let count = 0;
  const flush = (): void => {
    if (count === 0) return;
    output.push(input.count ? `${count.toString().padStart(7)} ${previousLine}` : previousLine);
  };
  for (const line of logical.lines) {
    const key = input.ignoreCase ? line.toLowerCase() : line;
    if (count > 0 && key === previousKey) {
      count += 1;
      continue;
    }
    flush();
    previousKey = key;
    previousLine = line;
    count = 1;
  }
  flush();
  return {
    stdout: joinLogicalLines({ lines: output, finalNewline: logical.finalNewline }),
    data: { inputLines: logical.lines.length, outputLines: output.length },
  };
}

export const uniqCommand: CommandDefinition = {
  name: "uniq",
  execute(context, input) {
    const record = inputRecord(input);
    return runUniq(context, {
      text: commandText(context, record),
      count: booleanValue(record, "count"),
      ignoreCase: booleanValue(record, "ignoreCase"),
    });
  },
};
