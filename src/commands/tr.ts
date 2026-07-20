import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import { booleanValue, inputRecord, stringValue } from "../core/validation.js";
import { commandText } from "./text-input.js";

export interface TrInput {
  text: string;
  from: string;
  to?: string;
  delete?: boolean;
}

export async function runTr(
  _context: CommandContext,
  input: TrInput,
): Promise<CommandPayload<{ inputCharacters: number; outputCharacters: number }>> {
  const source = [...input.from];
  if (source.length === 0) throw new VfsError("EINVAL", "from cannot be empty");
  const inputCharacters = [...input.text].length;
  let stdout: string;
  if (input.delete) {
    const removed = new Set(source);
    stdout = [...input.text].filter((character) => !removed.has(character)).join("");
  } else {
    const target = [...(input.to ?? "")];
    const finalTarget = target.at(-1);
    if (finalTarget === undefined) {
      throw new VfsError("EINVAL", "to cannot be empty when delete is false");
    }
    const replacements = new Map<string, string>();
    source.forEach((character, index) => {
      replacements.set(character, target[index] ?? finalTarget);
    });
    stdout = [...input.text].map((character) => replacements.get(character) ?? character).join("");
  }
  return {
    stdout,
    data: { inputCharacters, outputCharacters: [...stdout].length },
  };
}

export const trCommand: CommandDefinition = {
  name: "tr",
  execute(context, input) {
    const record = inputRecord(input);
    return runTr(context, {
      text: commandText(context, record),
      from: stringValue(record, "from"),
      to: stringValue(record, "to", ""),
      delete: booleanValue(record, "delete"),
    });
  },
};
