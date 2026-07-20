import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import {
  booleanValue,
  inputRecord,
  optionalInteger,
  optionalStringChoice,
  stringValue,
} from "../core/validation.js";
import { WRITE_DISPOSITIONS } from "../core/types.js";
import type { WriteResult, WriteTextOptions } from "../core/types.js";
import { commandPath } from "./common.js";

export interface WriteInput extends WriteTextOptions {
  path: string;
  text: string;
}

export async function runWrite(
  context: CommandContext,
  input: WriteInput,
): Promise<CommandPayload<WriteResult>> {
  const { path, text, ...options } = input;
  const result = await context.fileSystem.writeText(
    commandPath(context, path),
    text,
    options,
  );
  return { data: result };
}

export const writeCommand: CommandDefinition = {
  name: "write",
  execute(context, input) {
    const record = inputRecord(input);
    const disposition = optionalStringChoice(record, "disposition", WRITE_DISPOSITIONS);
    const ifRevision = optionalInteger(record, "ifRevision", 1, Number.MAX_SAFE_INTEGER);
    const mode = optionalInteger(record, "mode", 0, 0o177777);
    return runWrite(context, {
      path: stringValue(record, "path"),
      text: stringValue(record, "text"),
      createParents: booleanValue(record, "createParents"),
      ...(ifRevision === undefined ? {} : { ifRevision }),
      ...(mode === undefined ? {} : { mode }),
      ...(disposition === undefined ? {} : { disposition }),
    });
  },
};
