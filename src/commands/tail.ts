import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, optionalInteger, stringValue } from "../core/validation.js";
import type { TextSliceOptions } from "../core/types.js";
import { commandPath, textSliceOptions } from "./common.js";

export type TailInput = TextSliceOptions & {
  path: string;
};

export async function runTail(
  context: CommandContext,
  input: TailInput,
): Promise<CommandPayload<{ path: string; bytesRead: number }>> {
  const path = commandPath(context, input.path);
  const result = await context.fileSystem.readTextTail(
    path,
    textSliceOptions(input.lines, input.bytes),
  );
  return { stdout: result.text, data: { path, bytesRead: result.bytesRead } };
}

export const tailCommand: CommandDefinition = {
  name: "tail",
  execute(context, input) {
    const record = inputRecord(input);
    const options = textSliceOptions(
      optionalInteger(record, "lines", 0, 1_000_000),
      optionalInteger(record, "bytes", 0, 8 * 1024 * 1024),
    );
    return runTail(context, {
      path: stringValue(record, "path"),
      ...options,
    });
  },
};
