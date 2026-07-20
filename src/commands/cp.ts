import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, booleanValue, stringValue } from "../core/validation.js";
import type { WriteResult, WriteTextOptions } from "../core/types.js";
import { basename } from "../core/path.js";
import { isVfsError } from "../core/errors.js";
import { commandPath } from "./common.js";

export interface CpInput extends Pick<WriteTextOptions, "createParents"> {
  from: string;
  to: string;
}

export async function runCp(
  context: CommandContext,
  input: CpInput,
): Promise<CommandPayload<WriteResult>> {
  const source = commandPath(context, input.from);
  let target = commandPath(context, input.to);
  try {
    const destination = await context.fileSystem.stat(target);
    if (destination.kind === "directory") target = `${target === "/" ? "" : target}/${basename(source)}`;
  } catch (error) {
    if (!isVfsError(error) || error.code !== "ENOENT") throw error;
  }
  const read = await context.fileSystem.readText(source);
  const result = await context.fileSystem.writeText(target, read.text, {
    createParents: input.createParents ?? false,
    mode: read.stat.mode,
  });
  return { data: result };
}

export const cpCommand: CommandDefinition = {
  name: "cp",
  execute(context, input) {
    const record = inputRecord(input);
    return runCp(context, {
      from: stringValue(record, "from"),
      to: stringValue(record, "to"),
      createParents: booleanValue(record, "createParents"),
    });
  },
};
