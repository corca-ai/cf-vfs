import type { CommandContext } from "../core/command.js";
import { normalizePath } from "../core/path.js";
import { inputRecord, optionalString, stringArray, stringValue } from "../core/validation.js";

export function commandPath(context: CommandContext, path = "."): string {
  return normalizePath(path, context.cwd);
}

export function oneOrManyPaths(
  input: unknown,
  defaultPath?: string,
): { record: Record<string, unknown>; paths: string[] } {
  const record = inputRecord(input);
  const many = stringArray(record, "paths");
  if (many.length > 0) return { record, paths: many };
  const one = optionalString(record, "path") ?? defaultPath;
  if (one === undefined) stringValue(record, "path");
  return { record, paths: [one ?? ""] };
}

export function modeString(mode: number): string {
  const kind = (mode & 0o040000) !== 0 ? "d" : "-";
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const labels = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return kind + bits.map((bit, index) => (mode & bit) !== 0 ? labels[index] : "-").join("");
}
