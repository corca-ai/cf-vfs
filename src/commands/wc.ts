import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { booleanValue } from "../core/validation.js";
import { commandPath, oneOrManyPaths } from "./common.js";

export interface WcInput {
  paths: string[];
  bytes?: boolean;
  lines?: boolean;
  words?: boolean;
}

export interface WcEntry {
  path: string;
  bytes: number;
  lines: number;
  words: number;
}

export async function runWc(
  context: CommandContext,
  input: WcInput,
): Promise<CommandPayload<{ entries: WcEntry[] }>> {
  const flagsSpecified = input.bytes || input.lines || input.words;
  const showBytes = flagsSpecified ? Boolean(input.bytes) : true;
  const showLines = flagsSpecified ? Boolean(input.lines) : true;
  const showWords = flagsSpecified ? Boolean(input.words) : true;
  const entries: WcEntry[] = [];
  for (const requested of input.paths) {
    const path = commandPath(context, requested);
    const read = await context.fileSystem.readText(path);
    const words = read.text.trim().length === 0 ? 0 : read.text.trim().split(/\s+/u).length;
    entries.push({ path, bytes: read.stat.sizeBytes, lines: read.stat.lineCount, words });
  }
  const stdout = entries.map((entry) => [
    showLines ? entry.lines.toString().padStart(8) : null,
    showWords ? entry.words.toString().padStart(8) : null,
    showBytes ? entry.bytes.toString().padStart(8) : null,
    entry.path,
  ].filter((value) => value !== null).join(" ")).join("\n");
  return { stdout: `${stdout}\n`, data: { entries } };
}

export const wcCommand: CommandDefinition = {
  name: "wc",
  execute(context, input) {
    const { record, paths } = oneOrManyPaths(input);
    return runWc(context, {
      paths,
      bytes: booleanValue(record, "bytes"),
      lines: booleanValue(record, "lines"),
      words: booleanValue(record, "words"),
    });
  },
};
