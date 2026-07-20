import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import type { TouchOptions, VfsStat } from "../core/types.js";
import { booleanValue, optionalInteger } from "../core/validation.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface TouchInput extends TouchOptions {
  paths: string[];
}

export async function runTouch(
  context: CommandContext,
  input: TouchInput,
): Promise<CommandPayload<{ entries: VfsStat[] }>> {
  const entries: VfsStat[] = [];
  for (const requested of input.paths) {
    entries.push(await context.fileSystem.touch(commandPath(context, requested), {
      create: input.create ?? true,
      createParents: input.createParents ?? false,
      ...(input.ifRevision === undefined ? {} : { ifRevision: input.ifRevision }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.modifiedAtMs === undefined ? {} : { modifiedAtMs: input.modifiedAtMs }),
    }));
  }
  return { data: { entries } };
}

export const touchCommand: CommandDefinition = {
  name: "touch",
  execute(context, input) {
    const { record, paths } = oneOrManyPaths(input);
    const ifRevision = optionalInteger(record, "ifRevision", 1, Number.MAX_SAFE_INTEGER);
    const mode = optionalInteger(record, "mode", 0, 0o177777);
    const modifiedAtMs = optionalInteger(record, "modifiedAtMs", 0, Number.MAX_SAFE_INTEGER);
    return runTouch(context, {
      paths,
      create: booleanValue(record, "create", true),
      createParents: booleanValue(record, "createParents"),
      ...(ifRevision === undefined ? {} : { ifRevision }),
      ...(mode === undefined ? {} : { mode }),
      ...(modifiedAtMs === undefined ? {} : { modifiedAtMs }),
    });
  },
};
