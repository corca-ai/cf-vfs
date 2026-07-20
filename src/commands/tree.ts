import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { depthFrom } from "../core/path.js";
import type { VfsStat } from "../core/types.js";
import { inputRecord, integerValue, stringValue } from "../core/validation.js";
import { commandPath } from "./common.js";

export interface TreeInput {
  path?: string;
  maxDepth?: number;
  limit?: number;
}

export interface TreeData {
  root: VfsStat;
  entries: VfsStat[];
  directories: number;
  files: number;
  truncated: boolean;
}

export async function runTree(
  context: CommandContext,
  input: TreeInput = {},
): Promise<CommandPayload<TreeData>> {
  const requested = commandPath(context, input.path);
  const root = await context.fileSystem.stat(requested);
  const limit = input.limit ?? 10_000;
  const candidates = root.kind === "directory"
    ? await context.fileSystem.find({
        path: requested,
        limit: limit + 1,
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      })
    : [];
  const truncated = candidates.length > limit;
  const entries = candidates.slice(0, limit);
  const lines = [root.path];
  for (const entry of entries) {
    lines.push(`${"  ".repeat(depthFrom(root.path, entry.path))}${entry.name}`);
  }
  return {
    stdout: `${lines.join("\n")}\n`,
    data: {
      root,
      entries,
      directories: entries.filter((entry) => entry.kind === "directory").length,
      files: entries.filter((entry) => entry.kind === "file").length,
      truncated,
    },
  };
}

export const treeCommand: CommandDefinition = {
  name: "tree",
  execute(context, input) {
    const record = inputRecord(input);
    return runTree(context, {
      path: stringValue(record, "path", "."),
      maxDepth: integerValue(record, "maxDepth", 1_000_000, 0, 1_000_000),
      limit: integerValue(record, "limit", 10_000, 1, 99_999),
    });
  },
};
