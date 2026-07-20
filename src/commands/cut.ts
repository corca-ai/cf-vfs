import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import { inputRecord, stringValue } from "../core/validation.js";
import type { InputRecord } from "../core/validation.js";
import { commandText, joinLogicalLines, splitLogicalLines } from "./text-input.js";

export interface CutInput {
  text: string;
  delimiter?: string;
  fields: number[];
}

function fieldNumbers(record: InputRecord): number[] {
  const value = record["fields"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new VfsError("EINVAL", "fields must be a non-empty array of positive integers");
  }
  const fields: number[] = [];
  for (const field of value) {
    if (typeof field !== "number" || !Number.isInteger(field) || field < 1) {
      throw new VfsError("EINVAL", "fields must be a non-empty array of positive integers");
    }
    fields.push(field);
  }
  return [...new Set(fields)];
}

export async function runCut(
  _context: CommandContext,
  input: CutInput,
): Promise<CommandPayload<{ lines: number; fields: number[] }>> {
  const delimiter = input.delimiter ?? "\t";
  if (delimiter.length === 0) throw new VfsError("EINVAL", "delimiter cannot be empty");
  const logical = splitLogicalLines(input.text);
  const lines = logical.lines.map((line) => {
    if (!line.includes(delimiter)) return line;
    const values = line.split(delimiter);
    return input.fields.map((field) => values[field - 1] ?? "").join(delimiter);
  });
  return {
    stdout: joinLogicalLines({ lines, finalNewline: logical.finalNewline }),
    data: { lines: lines.length, fields: input.fields },
  };
}

export const cutCommand: CommandDefinition = {
  name: "cut",
  execute(context, input) {
    const record = inputRecord(input);
    return runCut(context, {
      text: commandText(context, record),
      delimiter: stringValue(record, "delimiter", "\t"),
      fields: fieldNumbers(record),
    });
  },
};
