import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord } from "../core/validation.js";

export async function runPwd(
  context: CommandContext,
): Promise<CommandPayload<{ cwd: string }>> {
  return { stdout: `${context.cwd}\n`, data: { cwd: context.cwd } };
}

export const pwdCommand: CommandDefinition = {
  name: "pwd",
  execute(context, input) {
    inputRecord(input);
    return runPwd(context);
  },
};
