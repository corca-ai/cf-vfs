import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import type { RemoveResult } from "../core/types.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface RmdirInput {
  paths: string[];
}

export async function runRmdir(
  context: CommandContext,
  input: RmdirInput,
): Promise<CommandPayload<{ results: RemoveResult[] }>> {
  const results: RemoveResult[] = [];
  for (const requested of input.paths) {
    const path = commandPath(context, requested);
    const stat = await context.fileSystem.stat(path);
    if (stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", stat.path);
    results.push(await context.fileSystem.remove(path));
  }
  return { data: { results } };
}

export const rmdirCommand: CommandDefinition = {
  name: "rmdir",
  execute(context, input) {
    const { paths } = oneOrManyPaths(input);
    return runRmdir(context, { paths });
  },
};
