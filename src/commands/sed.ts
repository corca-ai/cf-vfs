import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, booleanValue, optionalInteger, stringValue } from "../core/validation.js";
import type { ReplaceTextResult } from "../core/types.js";
import { commandPath } from "./common.js";

export interface SedInput {
  path: string;
  pattern: string;
  replacement: string;
  fixed?: boolean;
  ignoreCase?: boolean;
  global?: boolean;
  ifRevision?: number;
}

export async function runSed(
  context: CommandContext,
  input: SedInput,
): Promise<CommandPayload<ReplaceTextResult>> {
  const result = await context.fileSystem.replaceText({
    ...input,
    path: commandPath(context, input.path),
  });
  return { data: result };
}

export const sedCommand: CommandDefinition = {
  name: "sed",
  execute(context, input) {
    const record = inputRecord(input);
    return runSed(context, {
      path: stringValue(record, "path"),
      pattern: stringValue(record, "pattern"),
      replacement: stringValue(record, "replacement"),
      fixed: booleanValue(record, "fixed"),
      ignoreCase: booleanValue(record, "ignoreCase"),
      global: booleanValue(record, "global"),
      ifRevision: optionalInteger(record, "ifRevision", 1, Number.MAX_SAFE_INTEGER),
    });
  },
};
