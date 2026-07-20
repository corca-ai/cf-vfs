import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { isVfsError } from "../core/errors.js";
import type { VfsStat } from "../core/types.js";
import { booleanValue, inputRecord, optionalStringChoice, stringValue } from "../core/validation.js";
import { commandPath } from "./common.js";

export const TEST_PREDICATES = [
  "exists",
  "file",
  "directory",
  "text",
  "binary",
  "nonempty",
] as const;
export type TestPredicate = typeof TEST_PREDICATES[number];

export interface TestInput {
  path: string;
  predicate?: TestPredicate;
  negate?: boolean;
}

function matchesPredicate(stat: VfsStat, predicate: TestPredicate): boolean {
  if (predicate === "exists") return true;
  if (predicate === "file") return stat.kind === "file";
  if (predicate === "directory") return stat.kind === "directory";
  if (predicate === "text") return stat.contentKind === "text";
  if (predicate === "binary") return stat.contentKind === "binary";
  return stat.kind === "file" && stat.sizeBytes > 0;
}

export async function runTest(
  context: CommandContext,
  input: TestInput,
): Promise<CommandPayload<{ path: string; matched: boolean; stat: VfsStat | null }>> {
  const path = commandPath(context, input.path);
  let stat: VfsStat | null = null;
  try {
    stat = await context.fileSystem.stat(path);
  } catch (error) {
    if (!isVfsError(error) || error.code !== "ENOENT") throw error;
  }
  const rawMatch = stat !== null && matchesPredicate(stat, input.predicate ?? "exists");
  const matched = input.negate ? !rawMatch : rawMatch;
  return { exitCode: matched ? 0 : 1, data: { path, matched, stat } };
}

export const testCommand: CommandDefinition = {
  name: "test",
  execute(context, input) {
    const record = inputRecord(input);
    const predicate = optionalStringChoice(record, "predicate", TEST_PREDICATES);
    return runTest(context, {
      path: stringValue(record, "path"),
      ...(predicate === undefined ? {} : { predicate }),
      negate: booleanValue(record, "negate"),
    });
  },
};
