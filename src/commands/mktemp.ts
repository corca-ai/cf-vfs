import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { isVfsError, VfsError } from "../core/errors.js";
import { dirname } from "../core/path.js";
import type { VfsStat } from "../core/types.js";
import { booleanValue, inputRecord, optionalInteger, stringValue } from "../core/validation.js";
import { commandPath } from "./common.js";

const MAX_ATTEMPTS = 16;

export interface MktempInput {
  template?: string;
  directory?: boolean;
  createParents?: boolean;
  mode?: number;
}

function randomCharacters(length: number): string {
  let value = "";
  while (value.length < length) value += crypto.randomUUID().replaceAll("-", "");
  return value.slice(0, length);
}

export async function runMktemp(
  context: CommandContext,
  input: MktempInput = {},
): Promise<CommandPayload<{ path: string; stat: VfsStat }>> {
  const template = commandPath(context, input.template ?? "/tmp/tmp.XXXXXXXX");
  const marker = template.match(/X{6,}$/u);
  if (!marker || marker.index === undefined) {
    throw new VfsError("EINVAL", "template must end with at least six X characters");
  }
  const prefix = template.slice(0, marker.index);
  const createParents = input.createParents ?? true;
  if (input.directory && createParents) await context.fileSystem.mkdir(dirname(template), true);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const path = `${prefix}${randomCharacters(marker[0].length)}`;
    try {
      let stat: VfsStat;
      if (input.directory) {
        stat = await context.fileSystem.mkdir(path, false, 0o040000 | (input.mode ?? 0o700));
      } else {
        await context.fileSystem.writeText(path, "", {
          disposition: "create",
          createParents,
          mode: 0o100000 | (input.mode ?? 0o600),
        });
        stat = await context.fileSystem.stat(path);
      }
      return { stdout: `${path}\n`, data: { path, stat } };
    } catch (error) {
      if (!isVfsError(error) || error.code !== "EEXIST") throw error;
    }
  }
  throw new VfsError("EEXIST", `could not allocate a unique path after ${MAX_ATTEMPTS} attempts`);
}

export const mktempCommand: CommandDefinition = {
  name: "mktemp",
  execute(context, input) {
    const record = inputRecord(input);
    const mode = optionalInteger(record, "mode", 0, 0o7777);
    return runMktemp(context, {
      template: stringValue(record, "template", "/tmp/tmp.XXXXXXXX"),
      directory: booleanValue(record, "directory"),
      createParents: booleanValue(record, "createParents", true),
      ...(mode === undefined ? {} : { mode }),
    });
  },
};
