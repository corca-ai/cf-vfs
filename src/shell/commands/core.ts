import { VfsError } from "../../core/errors.js";
import { compareUtf8, normalizePath } from "../../core/path.js";
import type { ShellCommandContext } from "../types.js";
import { type AppletSpec, appletUsageError, defineApplet } from "./applet.js";
import { type BufferLease, commandPath, parseInteger, readFileText, writeText } from "./helpers.js";

const COLON = {
  name: ":",
  usage: "",
  summary: "does nothing and succeeds",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const TRUE = {
  name: "true",
  usage: "",
  summary: "succeeds",
  kind: "builtin",
} as const satisfies AppletSpec;
const FALSE = {
  name: "false",
  usage: "",
  summary: "fails with status 1",
  kind: "builtin",
} as const satisfies AppletSpec;

const ECHO = {
  name: "echo",
  usage: "[-n] [ARGUMENT...]",
  summary: "writes arguments separated by spaces",
  kind: "builtin",
} as const satisfies AppletSpec;

const PWD = {
  name: "pwd",
  usage: "",
  summary: "prints the working directory",
  kind: "builtin",
} as const satisfies AppletSpec;

const CD = {
  name: "cd",
  usage: "[DIRECTORY|-]",
  summary: "changes the working directory",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const EXPORT = {
  name: "export",
  usage: "[NAME[=VALUE]...]",
  summary: "marks variables for the session environment",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const ENV = {
  name: "env",
  usage: "[NAME=VALUE...] [COMMAND [ARGUMENT...]]",
  summary: "prints the environment or runs a command with assignments",
} as const satisfies AppletSpec;

const UNSET = {
  name: "unset",
  usage: "[NAME...]",
  summary: "removes variables",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const LOCAL = {
  name: "local",
  usage: "NAME[=VALUE]...",
  summary: "declares function-scoped variables",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const RETURN = {
  name: "return",
  usage: "[STATUS]",
  summary: "returns from a function or sourced file",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const BREAK = {
  name: "break",
  usage: "[LEVELS]",
  summary: "exits enclosing loops",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const CONTINUE = {
  name: "continue",
  usage: "[LEVELS]",
  summary: "resumes the next iteration of an enclosing loop",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const EXIT = {
  name: "exit",
  usage: "[STATUS]",
  summary: "ends the execution unit",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const SET = {
  name: "set",
  usage: "[-eu|+eu] [-o|+o OPTION] [-- ARGUMENT...]",
  summary: "sets shell options or positional parameters",
  kind: "session-builtin",
} as const satisfies AppletSpec;

export const colonCommand = /* @__PURE__ */ defineApplet(COLON, () => 0);
export const trueCommand = /* @__PURE__ */ defineApplet(TRUE, () => 0);
export const falseCommand = /* @__PURE__ */ defineApplet(FALSE, () => 1);
export { getoptsCommand, readCommand, shiftCommand } from "./core-input.js";
export { bracketCommand, groupsCommand, idCommand, testCommand } from "./core-inspect.js";
export { printfCommand } from "./core-printf.js";

export const echoCommand = /* @__PURE__ */ defineApplet(ECHO, async (_context, argv, fds) => {
  let newline = true;
  let start = 0;
  if (argv[0] === "-n") {
    newline = false;
    start = 1;
  }
  await writeText(fds[1], `${argv.slice(start).join(" ")}${newline ? "\n" : ""}`);
  return 0;
});

export const pwdCommand = /* @__PURE__ */ defineApplet(PWD, async (context, argv, fds) => {
  if (argv.length > 0) throw appletUsageError(PWD, `unsupported option ${argv[0] ?? ""}`);
  await writeText(fds[1], `${context.session.cwd}\n`);
  return 0;
});

export const cdCommand = /* @__PURE__ */ defineApplet(CD, async (context, argv, fds) => {
  if (argv.length > 1) throw appletUsageError(CD, "too many arguments");
  const [operand] = argv;
  if (operand === "") throw appletUsageError(CD, "directory must not be empty");
  const previous = context.session.cwd;
  let requested: string;
  if (operand === "-") {
    const old = context.session.env.get("OLDPWD");
    // Bash refuses rather than guessing when there is no previous directory.
    if (old === undefined || old === "") throw appletUsageError(CD, "OLDPWD not set");
    requested = old;
  } else if (operand === undefined) {
    const home = context.session.env.get("HOME");
    if (home === undefined || home === "") throw appletUsageError(CD, "HOME not set");
    requested = home;
  } else {
    requested = operand;
  }
  const target = normalizePath(requested, previous);
  const stat = context.fileSystem.stat(target);
  if (stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", target);
  context.session.cwd = target;
  context.session.env.set("OLDPWD", previous);
  context.session.env.set("PWD", target);
  // `cd -` reports where it went, as Bash does, so a script can see the swap.
  if (operand === "-") await writeText(fds[1], `${target}\n`);
  return 0;
});

function assignment(value: string): { name: string; value: string } {
  const separator = value.indexOf("=");
  const name = separator < 0 ? value : value.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new VfsError("EINVAL", `invalid variable name: ${name}`);
  }
  return { name, value: separator < 0 ? "" : value.slice(separator + 1) };
}

interface EnvironmentAssignment {
  name: string;
  value: string;
}

function parseEnvInvocation(argv: readonly string[]): {
  assignments: EnvironmentAssignment[];
  invocation: readonly string[];
} {
  let index = 0;
  const assignments: EnvironmentAssignment[] = [];
  while (index < argv.length) {
    const value = argv[index] ?? "";
    if (value === "--") return { assignments, invocation: argv.slice(index + 1) };
    if (value.startsWith("-")) throw appletUsageError(ENV, `unsupported option ${value}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) break;
    const separator = value.indexOf("=");
    assignments.push({ name: value.slice(0, separator), value: value.slice(separator + 1) });
    index += 1;
  }
  return { assignments, invocation: argv.slice(index) };
}

function applyEnvironmentAssignments(
  context: ShellCommandContext,
  assignments: readonly EnvironmentAssignment[],
): void {
  for (const { name, value } of assignments) context.session.env.set(name, value);
}

function renderEnvironment(context: ShellCommandContext): string {
  const names = [...context.session.env.keys()]
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
    .sort(compareUtf8);
  let output = "";
  for (const name of names) output += `${name}=${context.session.env.get(name) ?? ""}\n`;
  return output;
}

async function executeWithEnvironment(
  context: ShellCommandContext,
  invocation: readonly string[],
  assignments: readonly EnvironmentAssignment[],
  fds: Parameters<ShellCommandContext["executeCommand"]>[1],
): Promise<number> {
  const previous = new Map<string, string | undefined>();
  for (const { name, value } of assignments) {
    previous.set(name, context.session.env.get(name));
    context.session.env.set(name, value);
  }
  try {
    return await context.executeCommand(invocation, fds);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) context.session.env.delete(name);
      else context.session.env.set(name, value);
    }
  }
}

export const exportCommand = /* @__PURE__ */ defineApplet(EXPORT, (context, argv) => {
  for (const value of argv) {
    const parsed = assignment(value);
    context.session.env.set(
      parsed.name,
      value.includes("=") ? parsed.value : (context.session.env.get(parsed.name) ?? ""),
    );
  }
  return 0;
});

/**
 * Prints the session environment, or runs a command with added assignments.
 *
 * Names sort by UTF-8 byte order so output is deterministic. Bash's `-i`,
 * `-u`, and `-0` options and the bare `-` form are outside this profile;
 * positional-parameter and shell-option state is not environment.
 */
export const envCommand = /* @__PURE__ */ defineApplet(ENV, async (context, argv, fds) => {
  const { assignments, invocation } = parseEnvInvocation(argv);
  if (invocation.length === 0) {
    applyEnvironmentAssignments(context, assignments);
    await writeText(fds[1], renderEnvironment(context));
    return 0;
  }
  return executeWithEnvironment(context, invocation, assignments, fds);
});

export const unsetCommand = /* @__PURE__ */ defineApplet(UNSET, (context, argv) => {
  for (const name of argv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw appletUsageError(UNSET, `invalid variable name: ${name}`);
    }
    context.session.env.delete(name);
  }
  return 0;
});

function defineSourceCommand(name: "source" | ".") {
  // `source` and `.` share one runner but keep separate specifications so a
  // diagnostic names the spelling the script actually used, exactly as Bash
  // does. They are built-ins: the file runs in the calling shell scope.
  const spec = {
    name,
    usage: "FILE [ARGUMENT...]",
    summary: "runs a bounded VFS file in the current shell scope",
    kind: "session-builtin",
  } as const satisfies AppletSpec;
  return defineApplet(spec, async (context, argv, fds) => {
    const [path, ...args] = argv;
    if (path === undefined) throw appletUsageError(spec, "missing file operand");
    const normalized = commandPath(context, path);
    let source: BufferLease<string>;
    try {
      source = await readFileText(context, normalized, context.budget.limits.maxScriptBytes);
    } catch (error) {
      if (
        error instanceof VfsError &&
        error.code === "E2BIG" &&
        error.message === "buffered command input limit exceeded"
      ) {
        throw new VfsError("E2BIG", "sourced file exceeds the script byte limit", normalized);
      }
      throw error;
    }
    try {
      if (source.value.includes("\0")) {
        throw new VfsError("EINVAL", "sourced file contains a NUL byte", normalized);
      }
      return await context.executeSource(source.value, normalized, args, fds);
    } finally {
      source.release();
    }
  });
}

export const sourceCommand = /* @__PURE__ */ defineSourceCommand("source");
export const dotCommand = /* @__PURE__ */ defineSourceCommand(".");

export const localCommand = /* @__PURE__ */ defineApplet(LOCAL, (context, argv) => {
  const frame = context.session.localFrames.at(-1);
  const getoptsFrame = context.session.localGetoptsFrames.at(-1);
  if (context.session.functionDepth === 0 || frame === undefined || getoptsFrame === undefined) {
    throw appletUsageError(LOCAL, "can only be used in a function");
  }
  for (const value of argv) {
    const parsed = assignment(value);
    if (!frame.has(parsed.name)) frame.set(parsed.name, context.session.env.get(parsed.name));
    if (parsed.name === "OPTIND" && !getoptsFrame.captured) {
      getoptsFrame.captured = true;
      getoptsFrame.state =
        context.session.getopts === undefined ? undefined : { ...context.session.getopts };
    }
    context.session.env.set(parsed.name, value.includes("=") ? parsed.value : "");
  }
  return 0;
});

export const returnCommand = /* @__PURE__ */ defineApplet(RETURN, (context, argv) => {
  if (context.session.functionDepth === 0 && context.session.sourceDepth === 0) {
    throw appletUsageError(RETURN, "can only be used in a function or sourced file");
  }
  if (argv.length > 1) throw appletUsageError(RETURN, "too many arguments");
  const status =
    argv[0] === undefined
      ? context.session.lastExitCode
      : parseInteger(argv[0], `${RETURN.name}: status`, Number.MIN_SAFE_INTEGER) & 0xff;
  context.session.flow = { type: "return", status };
  return status;
});

function loopControl(
  spec: AppletSpec & { readonly name: "break" | "continue" },
  context: ShellCommandContext,
  argv: readonly string[],
): number {
  if (context.session.loopDepth === 0) {
    throw appletUsageError(spec, "only meaningful in a loop");
  }
  if (argv.length > 1) throw appletUsageError(spec, "too many arguments");
  const requested = argv[0] === undefined ? 1 : parseInteger(argv[0], `${spec.name}: level`);
  if (requested <= 0) throw appletUsageError(spec, "level must be positive");
  context.session.flow = {
    type: spec.name,
    levels: Math.min(requested, context.session.loopDepth),
  };
  return 0;
}

export const breakCommand = /* @__PURE__ */ defineApplet(BREAK, (context, argv) =>
  loopControl(BREAK, context, argv),
);

export const continueCommand = /* @__PURE__ */ defineApplet(CONTINUE, (context, argv) =>
  loopControl(CONTINUE, context, argv),
);

export const exitCommand = /* @__PURE__ */ defineApplet(EXIT, (context, argv) => {
  if (argv.length > 1) throw appletUsageError(EXIT, "too many arguments");
  const code =
    argv[0] === undefined
      ? context.session.lastExitCode
      : parseInteger(argv[0], `${EXIT.name}: status`, Number.MIN_SAFE_INTEGER);
  context.session.exitRequested = true;
  context.session.requestedExitCode = code & 0xff;
  return context.session.requestedExitCode;
});

/** Short flags `set` accepts, and the option each one names. */
const SET_FLAGS: Readonly<Record<string, "errexit" | "nounset">> = {
  e: "errexit",
  u: "nounset",
};

/** Long option names `set -o` accepts. */
const SET_OPTIONS = ["errexit", "nounset", "pipefail"] as const;
type SetOption = (typeof SET_OPTIONS)[number];

interface SetUpdate {
  option: SetOption;
  enabled: boolean;
}

interface ParsedSetArguments {
  updates: SetUpdate[];
  positional: readonly string[] | undefined;
}

function applyShellOption(
  session: ShellCommandContext["session"],
  option: SetOption,
  enabled: boolean,
): void {
  if (option === "errexit") session.errexit = enabled;
  else if (option === "nounset") session.nounset = enabled;
  else session.pipefail = enabled;
}

function setOptionByName(name: string): SetOption {
  const option = SET_OPTIONS.find((candidate) => candidate === name);
  if (option === undefined) throw appletUsageError(SET, `unsupported option name: ${name}`);
  return option;
}

function shortSetOption(flag: string): SetOption {
  const option = Object.hasOwn(SET_FLAGS, flag) ? SET_FLAGS[flag] : undefined;
  if (option === undefined) throw appletUsageError(SET, `unsupported option -${flag}`);
  return option;
}

function parseSetCluster(argv: readonly string[], index: number, updates: SetUpdate[]): number {
  const value = argv[index] ?? "";
  const enabled = value.startsWith("-");
  if ((!enabled && !value.startsWith("+")) || value.length < 2) {
    throw appletUsageError(SET, `unsupported form: ${value}`);
  }
  for (const flag of value.slice(1)) {
    if (flag !== "o") updates.push({ option: shortSetOption(flag), enabled });
    else {
      const name = argv[++index];
      if (name === undefined) throw appletUsageError(SET, "-o requires an option name");
      updates.push({ option: setOptionByName(name), enabled });
    }
  }
  return index;
}

function parseSetArguments(argv: readonly string[]): ParsedSetArguments {
  const updates: SetUpdate[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") return { updates, positional: argv.slice(index + 1) };
    index = parseSetCluster(argv, index, updates);
  }
  return { updates, positional: undefined };
}

export const setCommand = /* @__PURE__ */ defineApplet(SET, (context, argv) => {
  if (argv.length === 0) return 0;
  const parsed = parseSetArguments(argv);
  for (const update of parsed.updates) {
    applyShellOption(context.session, update.option, update.enabled);
  }
  if (parsed.positional !== undefined) {
    context.session.args.splice(0, context.session.args.length, ...parsed.positional);
  }
  return 0;
});
