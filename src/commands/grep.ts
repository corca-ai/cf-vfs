import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, booleanValue, integerValue, optionalString, stringArray, stringValue } from "../core/validation.js";
import type { TextSearchOptions, TextSearchResult } from "../core/types.js";
import { commandPath } from "./common.js";

export type GrepInput = Omit<TextSearchOptions, "roots"> & {
  paths?: string[];
};

export async function runGrep(
  context: CommandContext,
  input: GrepInput,
): Promise<CommandPayload<TextSearchResult>> {
  const include = input.include;
  const result = await context.fileSystem.searchText({
    roots: (input.paths?.length ? input.paths : ["."]).map((path) => commandPath(context, path)),
    pattern: input.pattern,
    fixed: input.fixed ?? false,
    ignoreCase: input.ignoreCase ?? false,
    maxResults: input.maxResults ?? 1000,
    ...(include === undefined ? {} : { include }),
  });
  const stdout = result.matches
    .map((match) => `${match.path}:${match.line}:${match.column}:${match.text}`)
    .join("\n");
  return {
    exitCode: result.matches.length === 0 ? 1 : 0,
    stdout: stdout.length > 0 ? `${stdout}\n` : "",
    data: result,
  };
}

export const grepCommand: CommandDefinition = {
  name: "grep",
  execute(context, input) {
    const record = inputRecord(input);
    const include = optionalString(record, "include");
    return runGrep(context, {
      pattern: stringValue(record, "pattern"),
      paths: stringArray(record, "paths", ["."]),
      fixed: booleanValue(record, "fixed"),
      ignoreCase: booleanValue(record, "ignoreCase"),
      maxResults: integerValue(record, "maxResults", 1000, 1, 10_000),
      ...(include === undefined ? {} : { include }),
    });
  },
};
