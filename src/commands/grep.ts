import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, booleanValue, integerValue, optionalString, stringArray, stringValue } from "../core/validation.js";
import type { TextSearchResult } from "../core/types.js";
import { commandPath } from "./common.js";

export interface GrepInput {
  pattern: string;
  paths?: string[];
  fixed?: boolean;
  ignoreCase?: boolean;
  include?: string;
  maxResults?: number;
}

export async function runGrep(
  context: CommandContext,
  input: GrepInput,
): Promise<CommandPayload<TextSearchResult>> {
  const result = await context.fileSystem.searchText({
    roots: (input.paths?.length ? input.paths : ["."]).map((path) => commandPath(context, path)),
    pattern: input.pattern,
    fixed: input.fixed,
    ignoreCase: input.ignoreCase,
    include: input.include,
    maxResults: input.maxResults,
  });
  const stdout = result.matches
    .map((match) => `${match.path}:${match.line}:${match.column}:${match.text}`)
    .join("\n");
  return { stdout: stdout.length > 0 ? `${stdout}\n` : "", data: result };
}

export const grepCommand: CommandDefinition = {
  name: "grep",
  execute(context, input) {
    const record = inputRecord(input);
    return runGrep(context, {
      pattern: stringValue(record, "pattern"),
      paths: stringArray(record, "paths", ["."]),
      fixed: booleanValue(record, "fixed"),
      ignoreCase: booleanValue(record, "ignoreCase"),
      include: optionalString(record, "include"),
      maxResults: integerValue(record, "maxResults", 1000, 1, 10_000),
    });
  },
};
