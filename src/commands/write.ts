import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, booleanValue, optionalInteger, stringValue } from "../core/validation.js";
import type { WriteResult } from "../core/types.js";
import { commandPath } from "./common.js";

export interface WriteInput {
  path: string;
  text: string;
  createParents?: boolean;
  ifRevision?: number;
  mode?: number;
}

export async function runWrite(
  context: CommandContext,
  input: WriteInput,
): Promise<CommandPayload<WriteResult>> {
  const result = await context.fileSystem.writeText(
    commandPath(context, input.path),
    input.text,
    input,
  );
  return { data: result };
}

export const writeCommand: CommandDefinition = {
  name: "write",
  execute(context, input) {
    const record = inputRecord(input);
    return runWrite(context, {
      path: stringValue(record, "path"),
      text: stringValue(record, "text"),
      createParents: booleanValue(record, "createParents"),
      ifRevision: optionalInteger(record, "ifRevision", 1, Number.MAX_SAFE_INTEGER),
      mode: optionalInteger(record, "mode", 0, 0o177777),
    });
  },
};
