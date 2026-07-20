import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue, inputRecord, stringValue } from "../core/validation.js";
import type { MoveOptions, MoveResult } from "../core/types.js";
import { isVfsError } from "../core/errors.js";
import { basename } from "../core/path.js";
import { commandPath } from "./common.js";

export interface MvInput extends MoveOptions {
  from: string;
  to: string;
}

export async function runMv(
  context: CommandContext,
  input: MvInput,
): Promise<CommandPayload<MoveResult>> {
  const source = commandPath(context, input.from);
  let target = commandPath(context, input.to);
  try {
    const destination = await context.fileSystem.stat(target);
    if (destination.kind === "directory") {
      target = `${target === "/" ? "" : target}/${basename(source)}`;
    }
  } catch (error) {
    if (!isVfsError(error) || error.code !== "ENOENT") throw error;
  }
  const result = await context.fileSystem.move(source, target, { replace: input.replace ?? false });
  return { data: result };
}

export const mvCommand: CommandDefinition = {
  name: "mv",
  execute(context, input) {
    const record = inputRecord(input);
    return runMv(context, {
      from: stringValue(record, "from"),
      to: stringValue(record, "to"),
      replace: booleanValue(record, "replace"),
    });
  },
};
