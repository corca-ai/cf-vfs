import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import {
  booleanValue,
  inputRecord,
  integerValue,
  optionalString,
  optionalStringChoice,
  stringValue,
} from "../core/validation.js";
import { ENTRY_KINDS } from "../core/types.js";
import type { FindOptions, VfsStat } from "../core/types.js";
import { commandPath } from "./common.js";

export type FindInput = Omit<FindOptions, "path"> & {
  path?: string;
};

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
    const name = optionalString(record, "name");
    const pathGlob = optionalString(record, "pathGlob");
    const type = optionalStringChoice(record, "type", ENTRY_KINDS);
    return runFind(context, {
      path: stringValue(record, "path", "."),
      includeRoot: booleanValue(record, "includeRoot"),
      maxDepth: integerValue(record, "maxDepth", 1_000_000, 0, 1_000_000),
      limit: integerValue(record, "limit", 10_000, 1, 100_000),
      ...(name === undefined ? {} : { name }),
      ...(pathGlob === undefined ? {} : { pathGlob }),
      ...(type === undefined ? {} : { type }),
    });
  },
};
