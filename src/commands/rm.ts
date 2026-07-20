import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue } from "../core/validation.js";
import type { RemoveOptions, RemoveResult } from "../core/types.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface RmInput extends RemoveOptions {
  paths: string[];
}

export async function runRm(
  context: CommandContext,
  input: RmInput,
): Promise<CommandPayload<{ results: RemoveResult[] }>> {
  const results: RemoveResult[] = [];
  for (const path of input.paths) {
    results.push(await context.fileSystem.remove(commandPath(context, path), {
      recursive: input.recursive ?? false,
    }));
  }
  return { data: { results } };
}

export const rmCommand: CommandDefinition = {
  name: "rm",
  execute(context, input) {
    const { record, paths } = oneOrManyPaths(input);
    return runRm(context, { paths, recursive: booleanValue(record, "recursive") });
  },
};
