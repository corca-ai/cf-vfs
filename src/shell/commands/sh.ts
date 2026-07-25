import { VfsError } from "../../core/errors.js";
import { type AppletSpec, appletUsageError, defineApplet } from "./applet.js";
import { commandPath, readFileText } from "./helpers.js";

const SH = {
  name: "sh",
  aliases: ["bash"],
  usage: "[-c COMMAND [NAME [ARGUMENT...]] | FILE [ARGUMENT...]]",
  summary: "runs a bounded source unit in an isolated child shell",
} as const satisfies AppletSpec;

/**
 * The cf-vfs shell profile, reachable as `sh`, `bash`, `/bin/sh`, and
 * `/bin/bash`.
 *
 * Every spelling selects the same declared language, exported as
 * `BASH_COMPATIBILITY_VERSION`. It is not host Bash and claims none of its
 * behavior; the alias exists so a familiar script or shebang finds the profile
 * it means.
 *
 * The unit runs in an isolated child scope, so its variables, functions,
 * working directory, and `exit` stay inside it while the environment, options,
 * policy, cancellation, and the execution-wide budget come from the caller.
 * Interactive invocation, `-s`, `-l`, `-e`, job control, and reading a script
 * from standard input are outside the profile.
 */
export const shCommand = /* @__PURE__ */ defineApplet(SH, async (context, argv, fds) => {
  const [first, ...rest] = argv;
  if (first === undefined) {
    throw appletUsageError(SH, "reading a script from standard input is not supported");
  }
  if (first === "-c") {
    const [source, name, ...args] = rest;
    if (source === undefined) throw appletUsageError(SH, "-c requires a command");
    return await context.executeScript(source, name ?? SH.name, args, fds);
  }
  if (first.startsWith("-") && first !== "-") {
    throw appletUsageError(SH, `unsupported option ${first}`);
  }
  const path = commandPath(context, first);
  const source = await readFileText(context, path, context.budget.limits.maxScriptBytes);
  try {
    if (source.value.includes("\0")) {
      throw new VfsError("ENOEXEC", "contains a NUL byte", path);
    }
    return await context.executeScript(source.value, path, rest, fds);
  } finally {
    source.release();
  }
});
