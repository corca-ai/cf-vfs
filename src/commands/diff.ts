import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import { createLineDiff, renderLineDiff } from "../core/line-diff.js";
import { inputRecord, integerValue, stringValue } from "../core/validation.js";
import { commandPath } from "./common.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const HARD_MAX_BYTES = 8 * 1024 * 1024;

export interface DiffInput {
  from: string;
  to: string;
  maxBytes?: number;
}

export async function runDiff(
  context: CommandContext,
  input: DiffInput,
): Promise<CommandPayload<{
  from: string;
  to: string;
  equal: boolean;
  changes: number;
  bytesRead: number;
}>> {
  const from = commandPath(context, input.from);
  const to = commandPath(context, input.to);
  const maximumBytes = Math.min(input.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const [fromStat, toStat] = await Promise.all([
    context.fileSystem.stat(from),
    context.fileSystem.stat(to),
  ]);
  for (const stat of [fromStat, toStat]) {
    if (stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", stat.path);
    if (stat.contentKind !== "text") throw new VfsError("ENOTTEXT", "file is not a text file", stat.path);
    if (stat.sizeBytes > maximumBytes) {
      throw new VfsError("E2BIG", `file exceeds the ${maximumBytes}-byte diff limit`, stat.path);
    }
  }
  const [before, after] = await Promise.all([
    context.fileSystem.readText(from),
    context.fileSystem.readText(to),
  ]);
  if (before.text === after.text) {
    return {
      stdout: "",
      data: { from: fromStat.path, to: toStat.path, equal: true, changes: 0, bytesRead: before.bytesRead + after.bytesRead },
    };
  }
  const diff = createLineDiff(before.text, after.text);
  return {
    exitCode: 1,
    stdout: renderLineDiff(fromStat.path, toStat.path, diff),
    data: {
      from: fromStat.path,
      to: toStat.path,
      equal: false,
      changes: diff.changes,
      bytesRead: before.bytesRead + after.bytesRead,
    },
  };
}

export const diffCommand: CommandDefinition = {
  name: "diff",
  execute(context, input) {
    const record = inputRecord(input);
    return runDiff(context, {
      from: stringValue(record, "from"),
      to: stringValue(record, "to"),
      maxBytes: integerValue(record, "maxBytes", DEFAULT_MAX_BYTES, 0, HARD_MAX_BYTES),
    });
  },
};
