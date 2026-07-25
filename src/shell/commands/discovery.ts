import { compareUtf8 } from "../../core/path.js";
import type { ShellCommandResolution } from "../types.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { BufferedTextWriter, writeText } from "./helpers.js";

const COMMAND = {
  name: "command",
  usage: "[-v] NAME [ARGUMENT...]",
  summary: "runs a command ignoring shell functions, or reports how a name resolves",
  kind: "session-builtin",
  options: { short: { v: { name: "verify" } }, stopAtFirstOperand: true },
} as const satisfies AppletSpecWithOptions<"verify">;

const TYPE = {
  name: "type",
  usage: "NAME...",
  summary: "reports whether each name is a function, a built-in, or an applet",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const WHICH = {
  name: "which",
  usage: "NAME...",
  summary: "prints the applet path each name resolves to",
} as const satisfies AppletSpec;

const PRINTENV = {
  name: "printenv",
  usage: "[NAME...]",
  summary: "prints the environment, or the value of each named variable",
} as const satisfies AppletSpec;

/**
 * Renders the resolution of `name` the way `type` reports it.
 *
 * `path` is absent when a bare name resolved without a `PATH`, which is how a
 * `Shell` configured without the Linux profile behaves. Reporting the applet
 * name rather than inventing a path keeps the output honest about the fact
 * that nothing was searched.
 */
function describe(name: string, resolution: ShellCommandResolution): string {
  if (resolution.kind === "function") return `${name} is a function`;
  if (resolution.kind === "builtin") return `${name} is a shell builtin`;
  return resolution.path === undefined
    ? `${name} is a cf-vfs applet`
    : `${name} is ${resolution.path}`;
}

/**
 * Reports or runs a command, bypassing shell functions.
 *
 * `-v` prints how the name resolves and exits 1 when it does not. Without
 * `-v` the named applet runs even when a function shadows it, which is the
 * behavior scripts use to call through a wrapper. Bash's `-V` and `-p` forms
 * are outside this profile.
 */
export const commandCommand = /* @__PURE__ */ defineApplet(COMMAND, async (context, argv, fds) => {
  const parsed = parseAppletOptions(COMMAND, argv);
  const verify = parsed.options.some((option) => option.name === "verify");
  const [name, ...rest] = parsed.operands;
  if (name === undefined) throw appletUsageError(COMMAND, "missing command name");
  if (!verify) return await context.executeCommand([name, ...rest], fds, { bypassFunctions: true });
  if (rest.length > 0) throw appletUsageError(COMMAND, "-v accepts one name");
  const resolution = context.resolveCommand(name);
  if (resolution === undefined) return 1;
  // `command -v` prints something a script can run: a bare name for a function,
  // a built-in, or an applet reached without a searched path, and the applet
  // path itself when `PATH` selected one.
  const spelling = resolution.kind === "program" ? (resolution.path ?? name) : name;
  await writeText(fds[1], `${spelling}\n`);
  return 0;
});

/** Reports how each name resolves. Status 1 when any name is unknown. */
export const typeCommand = /* @__PURE__ */ defineApplet(TYPE, async (context, argv, fds) => {
  if (argv.length === 0) throw appletUsageError(TYPE, "missing operand");
  const output = new BufferedTextWriter(context, fds[1]);
  let status = 0;
  try {
    for (const name of argv) {
      const resolution = context.resolveCommand(name);
      if (resolution === undefined) {
        await writeText(fds[2], `type: ${name}: not found\n`);
        status = 1;
        continue;
      }
      await output.write(`${describe(name, resolution)}\n`);
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return status;
});

/**
 * Prints the applet path for each name.
 *
 * Like the Linux utility, `which` reports files rather than shell behavior: it
 * finds anything with a program form, including a built-in such as `echo` that
 * Linux also ships as a program, and does not find a function or a
 * session-scoped built-in such as `cd`. A name that resolved without a searched
 * path has no path to print and is likewise not found, which keeps `which`
 * from inventing a location.
 */
export const whichCommand = /* @__PURE__ */ defineApplet(WHICH, async (context, argv, fds) => {
  if (argv.length === 0) throw appletUsageError(WHICH, "missing operand");
  const output = new BufferedTextWriter(context, fds[1]);
  let status = 0;
  try {
    for (const name of argv) {
      const resolution = context.resolveCommand(name);
      const path = resolution?.kind === "function" ? undefined : resolution?.path;
      if (path === undefined) {
        status = 1;
        continue;
      }
      await output.write(`${path}\n`);
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return status;
});

/**
 * Prints environment values.
 *
 * With no operand it prints every variable whose name is a valid identifier in
 * UTF-8 byte order, matching `env`. With operands it prints one value per line
 * and exits 1 when any name is unset. The `-0` form is outside this profile.
 */
export const printenvCommand = /* @__PURE__ */ defineApplet(
  PRINTENV,
  async (context, argv, fds) => {
    const names = argv[0] === "--" ? argv.slice(1) : argv;
    for (const value of names) {
      if (value.startsWith("-") && value !== "-") {
        throw appletUsageError(PRINTENV, `unsupported option ${value}`);
      }
    }
    const output = new BufferedTextWriter(context, fds[1]);
    let status = 0;
    try {
      if (names.length === 0) {
        const names = [...context.session.env.keys()]
          .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
          .sort(compareUtf8);
        for (const name of names) {
          await output.write(`${name}=${context.session.env.get(name) ?? ""}\n`);
        }
      } else {
        for (const name of names) {
          const value = context.session.env.get(name);
          if (value === undefined) {
            status = 1;
            continue;
          }
          await output.write(`${value}\n`);
        }
      }
      await output.flush();
    } finally {
      output.abort();
    }
    return status;
  },
);

/** Every command-discovery applet, for a registry that wants all of them. */
export const discoveryShellCommands = [
  commandCommand,
  typeCommand,
  whichCommand,
  printenvCommand,
] as const;
