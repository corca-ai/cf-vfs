import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, optionalString, stringValue } from "../core/validation.js";

export interface BasenameInput {
  path: string;
  suffix?: string;
}

export function posixBasename(path: string, suffix?: string): string {
  if (/^\/+$/u.test(path)) return "/";
  const withoutTrailing = path.replace(/\/+$/u, "");
  let name = withoutTrailing.slice(withoutTrailing.lastIndexOf("/") + 1);
  if (suffix && suffix.length < name.length && name.endsWith(suffix)) {
    name = name.slice(0, -suffix.length);
  }
  return name;
}

export async function runBasename(
  _context: CommandContext,
  input: BasenameInput,
): Promise<CommandPayload<{ basename: string }>> {
  const basename = posixBasename(input.path, input.suffix);
  return { stdout: `${basename}\n`, data: { basename } };
}

export const basenameCommand: CommandDefinition = {
  name: "basename",
  execute(context, input) {
    const record = inputRecord(input);
    const suffix = optionalString(record, "suffix");
    return runBasename(context, {
      path: stringValue(record, "path"),
      ...(suffix === undefined ? {} : { suffix }),
    });
  },
};
