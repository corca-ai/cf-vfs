import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { isVfsError, VfsError } from "../core/errors.js";
import type { WriteResult } from "../core/types.js";
import { booleanValue, inputRecord, optionalInteger, stringArray } from "../core/validation.js";
import { commandPath } from "./common.js";
import { commandText } from "./text-input.js";

export interface TeeInput {
  paths: string[];
  text: string;
  append?: boolean;
  createParents?: boolean;
  ifRevision?: number;
}

export async function runTee(
  context: CommandContext,
  input: TeeInput,
): Promise<CommandPayload<{ results: WriteResult[] }>> {
  if (input.paths.length === 0) throw new VfsError("EINVAL", "paths cannot be empty");
  if (input.ifRevision !== undefined && input.paths.length !== 1) {
    throw new VfsError("EINVAL", "ifRevision requires exactly one output path");
  }
  const results: WriteResult[] = [];
  for (const requested of input.paths) {
    const path = commandPath(context, requested);
    if (!input.append) {
      results.push(await context.fileSystem.writeText(path, input.text, {
        createParents: input.createParents ?? false,
        ...(input.ifRevision === undefined ? {} : { ifRevision: input.ifRevision }),
      }));
      continue;
    }
    try {
      results.push(await context.fileSystem.appendText(path, input.text, {
        ...(input.ifRevision === undefined ? {} : { ifRevision: input.ifRevision }),
      }));
    } catch (error) {
      if (!isVfsError(error) || error.code !== "ENOENT" || input.ifRevision !== undefined) {
        throw error;
      }
      results.push(await context.fileSystem.writeText(path, input.text, {
        createParents: input.createParents ?? false,
        disposition: "create",
      }));
    }
  }
  return { stdout: input.text, data: { results } };
}

export const teeCommand: CommandDefinition = {
  name: "tee",
  execute(context, input) {
    const record = inputRecord(input);
    const ifRevision = optionalInteger(record, "ifRevision", 1, Number.MAX_SAFE_INTEGER);
    return runTee(context, {
      paths: stringArray(record, "paths"),
      text: commandText(context, record),
      append: booleanValue(record, "append"),
      createParents: booleanValue(record, "createParents"),
      ...(ifRevision === undefined ? {} : { ifRevision }),
    });
  },
};
