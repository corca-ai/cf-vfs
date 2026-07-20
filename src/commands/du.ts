import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { integerValue } from "../core/validation.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface DuInput {
  paths: string[];
  maxDepth?: number;
  limit?: number;
}

export interface DuEntry {
  path: string;
  sizeBytes: number;
  files: number;
  entriesVisited: number;
  truncated: boolean;
}

export async function runDu(
  context: CommandContext,
  input: DuInput,
): Promise<CommandPayload<{ entries: DuEntry[] }>> {
  const limit = input.limit ?? 10_000;
  const entries: DuEntry[] = [];
  for (const requested of input.paths) {
    const path = commandPath(context, requested);
    const root = await context.fileSystem.stat(path);
    const candidates = root.kind === "directory"
      ? await context.fileSystem.find({
          path,
          includeRoot: true,
          limit: limit + 1,
          ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        })
      : [root];
    const truncated = candidates.length > limit;
    const visited = candidates.slice(0, limit);
    entries.push({
      path: root.path,
      sizeBytes: visited.reduce(
        (total, entry) => total + (entry.kind === "file" ? entry.sizeBytes : 0),
        0,
      ),
      files: visited.filter((entry) => entry.kind === "file").length,
      entriesVisited: visited.length,
      truncated,
    });
  }
  return {
    stdout: entries.map((entry) => `${entry.sizeBytes}\t${entry.path}`).join("\n") + "\n",
    data: { entries },
  };
}

export const duCommand: CommandDefinition = {
  name: "du",
  execute(context, input) {
    const { record, paths } = oneOrManyPaths(input, ".");
    return runDu(context, {
      paths,
      maxDepth: integerValue(record, "maxDepth", 1_000_000, 0, 1_000_000),
      limit: integerValue(record, "limit", 10_000, 1, 99_999),
    });
  },
};
