import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue, inputRecord, stringArray, stringValue } from "../core/validation.js";
import { boundedTextValues, splitLogicalLines } from "./text-input.js";

export interface PasteInput {
  texts: string[];
  delimiter?: string;
  serial?: boolean;
}

export async function runPaste(
  _context: CommandContext,
  input: PasteInput,
): Promise<CommandPayload<{ rows: number }>> {
  const delimiter = input.delimiter ?? "\t";
  const inputs = input.texts.map((text) => splitLogicalLines(text).lines);
  const rows: string[] = [];
  if (input.serial) {
    for (const lines of inputs) rows.push(lines.join(delimiter));
  } else {
    const length = inputs.reduce((maximum, lines) => Math.max(maximum, lines.length), 0);
    for (let index = 0; index < length; index += 1) {
      rows.push(inputs.map((lines) => lines[index] ?? "").join(delimiter));
    }
  }
  return {
    stdout: rows.length === 0 ? "" : `${rows.join("\n")}\n`,
    data: { rows: rows.length },
  };
}

export const pasteCommand: CommandDefinition = {
  name: "paste",
  execute(context, input) {
    const record = inputRecord(input);
    const texts = boundedTextValues(
      context,
      stringArray(record, "texts", [context.stdin]),
      "texts",
    );
    return runPaste(context, {
      texts,
      delimiter: stringValue(record, "delimiter", "\t"),
      serial: booleanValue(record, "serial"),
    });
  },
};
