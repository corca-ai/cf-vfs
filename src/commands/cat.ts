import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface CatInput {
  paths: string[];
}

export async function runCat(
  context: CommandContext,
  input: CatInput,
): Promise<CommandPayload<{ paths: string[]; bytesRead: number }>> {
  const normalized = input.paths.map((path) => commandPath(context, path));
  const reads = await Promise.all(normalized.map((path) => context.fileSystem.readText(path)));
  return {
    stdout: reads.map((read) => read.text).join(""),
    data: {
      paths: normalized,
      bytesRead: reads.reduce((total, read) => total + read.bytesRead, 0),
    },
  };
}

export const catCommand: CommandDefinition = {
  name: "cat",
  execute(context, input) {
    const { paths } = oneOrManyPaths(input);
    return runCat(context, { paths });
  },
};
