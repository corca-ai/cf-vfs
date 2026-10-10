import { gitCommand } from "../src/shell/commands/git.js";
import type { ShellCommand } from "../src/shell/types.js";

/** Deterministic object identities for private comparisons, with real execution budgets. */
export function benchmarkGitCommand(identityTime?: number): ShellCommand {
  if (identityTime === undefined) return gitCommand;
  return {
    name: gitCommand.name,
    run: (context, argv, fds) => gitCommand.run({ ...context, now: () => identityTime }, argv, fds),
  };
}
