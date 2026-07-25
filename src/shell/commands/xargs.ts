import { VfsError } from "../../core/errors.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { parseInteger, readTextLines, writeText } from "./helpers.js";

const XARGS = {
  name: "xargs",
  usage: "[-0rt] [-n MAX-ARGS] [COMMAND [ARGUMENT...]]",
  summary: "runs a command once per batch of arguments read from standard input",
  options: {
    short: {
      n: { name: "max-args", argument: true },
      r: { name: "no-run-if-empty" },
      t: { name: "verbose" },
      "0": { name: "null" },
    },
    long: {
      "max-args": { name: "max-args", argument: true },
      "no-run-if-empty": { name: "no-run-if-empty" },
      verbose: { name: "verbose" },
      null: { name: "null" },
    },
    stopAtFirstOperand: true,
  },
} as const satisfies AppletSpecWithOptions<"max-args" | "no-run-if-empty" | "verbose" | "null">;

/**
 * Runs a command once per batch of arguments read from standard input.
 *
 * Input is data, not source: arguments split on the fixed whitespace profile
 * (or on NUL under `-0`) and are handed to the command registry already
 * expanded. There is no quote, backslash, or `eval` processing, so input can
 * never introduce shell syntax. Bash's quote-aware splitting and the `-I`,
 * `-P`, and `-L` options are outside this profile.
 */
export const xargsCommand = /* @__PURE__ */ defineApplet(XARGS, async (context, argv, fds) => {
  const parsed = parseAppletOptions(XARGS, argv);
  let maxArgs: number | undefined;
  let nullSeparated = false;
  let skipWhenEmpty = false;
  let verbose = false;
  for (const option of parsed.options) {
    if (option.name === "max-args" && "argument" in option) {
      maxArgs = parseInteger(option.argument, `${XARGS.name}: -n`, 1);
    }
    if (option.name === "null") nullSeparated = true;
    if (option.name === "no-run-if-empty") skipWhenEmpty = true;
    if (option.name === "verbose") verbose = true;
  }

  const [name = "echo", ...fixed] = parsed.operands;
  const collected: string[] = [];
  let heldBytes = 0;
  let release: () => void = () => undefined;

  const take = (value: string): void => {
    if (value.length === 0) return;
    context.budget.step();
    collected.push(value);
    heldBytes += new TextEncoder().encode(value).byteLength;
    release();
    release = context.budget.buffered(heldBytes);
  };

  /** Splits one chunk, returning the trailing token that may continue. */
  const consume = (chunk: string, final: boolean): string => {
    const parts = nullSeparated ? chunk.split("\0") : chunk.split(/[ \t\n]+/u);
    const remainder = final ? "" : (parts.pop() ?? "");
    for (const value of parts) take(value);
    return remainder;
  };

  try {
    let carry = "";
    for await (const line of readTextLines(context, fds[0])) {
      carry = consume(carry + line, false);
    }
    consume(carry, true);

    const batches: string[][] = [];
    if (maxArgs === undefined || collected.length === 0) batches.push(collected);
    else {
      for (let index = 0; index < collected.length; index += maxArgs) {
        batches.push(collected.slice(index, index + maxArgs));
      }
    }

    let status = 0;
    for (const batch of batches) {
      if (batch.length === 0 && skipWhenEmpty) continue;
      const invocation = [name, ...fixed, ...batch];
      if (verbose) await writeText(fds[2], `${invocation.join(" ")}\n`);
      const exitCode = await context.executeCommand(invocation, fds);
      if (exitCode === 255) {
        throw new VfsError("ECANCELED", "xargs: command exited with status 255");
      }
      if (exitCode === 126 || exitCode === 127) return exitCode;
      if (exitCode !== 0) status = 123;
    }
    return status;
  } finally {
    release();
  }
});
