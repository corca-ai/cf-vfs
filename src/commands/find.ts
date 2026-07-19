import { VfsError } from "../core/errors.js";
import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, booleanValue, integerValue, optionalString, stringValue } from "../core/validation.js";
import type { EntryKind, VfsStat } from "../core/types.js";
import { commandPath } from "./common.js";

export interface FindInput {
  path?: string;
  includeRoot?: boolean;
  maxDepth?: number;
  name?: string;
  pathGlob?: string;
  type?: EntryKind;
  limit?: number;
}

export async function runFind(
  context: CommandContext,
  input: FindInput = {},
): Promise<CommandPayload<{ entries: VfsStat[] }>> {
  const entries = await context.fileSystem.find({
    ...input,
    path: commandPath(context, input.path),
  });
  const stdout = entries.map((entry) => entry.path).join("\n");
  return { stdout: stdout.length > 0 ? `${stdout}\n` : "", data: { entries } };
}

export const findCommand: CommandDefinition = {
  name: "find",
  execute(context, input) {
    const record = inputRecord(input);
    const type = optionalString(record, "type");
    if (type !== undefined && type !== "file" && type !== "directory") {
      throw new VfsError("EINVAL", "type must be file or directory");
    }
    return runFind(context, {
      path: stringValue(record, "path", "."),
      includeRoot: booleanValue(record, "includeRoot"),
      maxDepth: integerValue(record, "maxDepth", 1_000_000, 0, 1_000_000),
      name: optionalString(record, "name"),
      pathGlob: optionalString(record, "pathGlob"),
      type,
      limit: integerValue(record, "limit", 10_000, 1, 100_000),
    });
  },
};
