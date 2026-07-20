import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import type { VfsStat } from "../core/types.js";
import { integerValue, optionalInteger } from "../core/validation.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface ChmodInput {
  paths: string[];
  mode: number;
  ifRevision?: number;
}

export async function runChmod(
  context: CommandContext,
  input: ChmodInput,
): Promise<CommandPayload<{ entries: VfsStat[] }>> {
  if (input.ifRevision !== undefined && input.paths.length !== 1) {
    throw new VfsError("EINVAL", "ifRevision requires exactly one path");
  }
  const entries: VfsStat[] = [];
  for (const requested of input.paths) {
    const path = commandPath(context, requested);
    const current = await context.fileSystem.stat(path);
    entries.push(await context.fileSystem.setMetadata(path, {
      mode: (current.mode & ~0o7777) | input.mode,
      ...(input.ifRevision === undefined ? {} : { ifRevision: input.ifRevision }),
    }));
  }
  return { data: { entries } };
}

export const chmodCommand: CommandDefinition = {
  name: "chmod",
  execute(context, input) {
    const { record, paths } = oneOrManyPaths(input);
    const ifRevision = optionalInteger(record, "ifRevision", 1, Number.MAX_SAFE_INTEGER);
    return runChmod(context, {
      paths,
      mode: integerValue(record, "mode", 0, 0, 0o7777),
      ...(ifRevision === undefined ? {} : { ifRevision }),
    });
  },
};
