import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import type { VfsStat } from "../core/types.js";
import { commandPath, modeString, oneOrManyPaths } from "./common.js";

export interface StatInput {
  paths: string[];
}

export async function runStat(
  context: CommandContext,
  input: StatInput,
): Promise<CommandPayload<{ entries: VfsStat[] }>> {
  const entries = await Promise.all(
    input.paths.map((path) => context.fileSystem.stat(commandPath(context, path))),
  );
  const stdout = entries
    .map((entry) =>
      `${entry.path}\n  Type: ${entry.kind}${entry.contentKind ? `/${entry.contentKind}` : ""}\n  Size: ${entry.sizeBytes}\tLines: ${entry.lineCount}\tRevision: ${entry.revision}\n  Mode: ${modeString(entry.mode)}\tModified: ${entry.modifiedAtMs}`)
    .join("\n");
  return { stdout: `${stdout}\n`, data: { entries } };
}

export const statCommand: CommandDefinition = {
  name: "stat",
  execute(context, input) {
    const { paths } = oneOrManyPaths(input);
    return runStat(context, { paths });
  },
};
