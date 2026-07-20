import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, stringValue } from "../core/validation.js";

export interface DirnameInput {
  path: string;
}

export function posixDirname(path: string): string {
  if (/^\/+$/u.test(path)) return "/";
  const withoutTrailing = path.replace(/\/+$/u, "");
  const separator = withoutTrailing.lastIndexOf("/");
  if (separator < 0) return ".";
  const parent = withoutTrailing.slice(0, separator).replace(/\/+$/u, "");
  return parent.length === 0 ? "/" : parent;
}

export async function runDirname(
  _context: CommandContext,
  input: DirnameInput,
): Promise<CommandPayload<{ dirname: string }>> {
  const dirname = posixDirname(input.path);
  return { stdout: `${dirname}\n`, data: { dirname } };
}

export const dirnameCommand: CommandDefinition = {
  name: "dirname",
  execute(context, input) {
    const record = inputRecord(input);
    return runDirname(context, { path: stringValue(record, "path") });
  },
};
