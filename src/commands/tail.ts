import { VfsError } from "../core/errors.js";
import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, optionalInteger, stringValue } from "../core/validation.js";
import { commandPath } from "./common.js";

export interface TailInput {
  path: string;
  lines?: number;
  bytes?: number;
}

export async function runTail(
  context: CommandContext,
  input: TailInput,
): Promise<CommandPayload<{ path: string; bytesRead: number }>> {
  if (input.lines !== undefined && input.bytes !== undefined) {
    throw new VfsError("EINVAL", "lines and bytes are mutually exclusive");
  }
  const path = commandPath(context, input.path);
  const result = await context.fileSystem.readTextTail(path, {
    lines: input.lines,
    bytes: input.bytes,
  });
  return { stdout: result.text, data: { path, bytesRead: result.bytesRead } };
}

export const tailCommand: CommandDefinition = {
  name: "tail",
  execute(context, input) {
    const record = inputRecord(input);
    return runTail(context, {
      path: stringValue(record, "path"),
      lines: optionalInteger(record, "lines", 0, 1_000_000),
      bytes: optionalInteger(record, "bytes", 0, 8 * 1024 * 1024),
    });
  },
};
