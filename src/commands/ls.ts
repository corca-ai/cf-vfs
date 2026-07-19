import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, booleanValue, stringValue } from "../core/validation.js";
import type { VfsStat } from "../core/types.js";
import { commandPath, modeString } from "./common.js";

export interface LsInput {
  path?: string;
  all?: boolean;
  long?: boolean;
}

export interface LsData {
  path: string;
  entries: VfsStat[];
}

export async function runLs(
  context: CommandContext,
  input: LsInput = {},
): Promise<CommandPayload<LsData>> {
  const path = commandPath(context, input.path);
  const target = await context.fileSystem.stat(path);
  const entries = target.kind === "directory" ? await context.fileSystem.list(path) : [target];
  const visible = input.all ? entries : entries.filter((entry) => !entry.name.startsWith("."));
  const stdout = visible
    .map((entry) => input.long
      ? `${modeString(entry.mode)} ${entry.sizeBytes.toString().padStart(10)} ${entry.revision.toString().padStart(6)} ${entry.name}`
      : entry.name)
    .join("\n");
  return { stdout: stdout.length > 0 ? `${stdout}\n` : "", data: { path, entries: visible } };
}

export const lsCommand: CommandDefinition = {
  name: "ls",
  execute(context, input) {
    const record = inputRecord(input);
    return runLs(context, {
      path: stringValue(record, "path", "."),
      all: booleanValue(record, "all"),
      long: booleanValue(record, "long"),
    });
  },
};
