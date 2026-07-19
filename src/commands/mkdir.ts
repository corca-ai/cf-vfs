import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue } from "../core/validation.js";
import type { VfsStat } from "../core/types.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface MkdirInput {
  paths: string[];
  parents?: boolean;
}

export async function runMkdir(
  context: CommandContext,
  input: MkdirInput,
): Promise<CommandPayload<{ entries: VfsStat[] }>> {
  const entries: VfsStat[] = [];
  for (const path of input.paths) {
    entries.push(await context.fileSystem.mkdir(commandPath(context, path), input.parents));
  }
  return { data: { entries } };
}

export const mkdirCommand: CommandDefinition = {
  name: "mkdir",
  execute(context, input) {
    const { record, paths } = oneOrManyPaths(input);
    return runMkdir(context, { paths, parents: booleanValue(record, "parents") });
  },
};
