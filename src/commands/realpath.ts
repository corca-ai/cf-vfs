import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { normalizePath } from "../core/path.js";
import { booleanValue, inputRecord, stringValue } from "../core/validation.js";
import { commandPath } from "./common.js";

export interface RealpathInput {
  path: string;
  requireExists?: boolean;
}

export async function runRealpath(
  context: CommandContext,
  input: RealpathInput,
): Promise<CommandPayload<{ path: string }>> {
  const path = input.requireExists === false
    ? normalizePath(input.path, context.cwd)
    : (await context.fileSystem.stat(commandPath(context, input.path))).path;
  return { stdout: `${path}\n`, data: { path } };
}

export const realpathCommand: CommandDefinition = {
  name: "realpath",
  execute(context, input) {
    const record = inputRecord(input);
    return runRealpath(context, {
      path: stringValue(record, "path"),
      requireExists: booleanValue(record, "requireExists", true),
    });
  },
};
