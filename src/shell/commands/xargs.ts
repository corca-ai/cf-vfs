import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
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

interface XargsOptions {
  readonly maxArgs: number | undefined;
  readonly nullSeparated: boolean;
  readonly skipWhenEmpty: boolean;
  readonly verbose: boolean;
}

function xargsOptions(argv: readonly string[]): {
  readonly options: XargsOptions;
  readonly operands: readonly string[];
} {
  const parsed = parseAppletOptions(XARGS, argv);
  let maxArgs: number | undefined;
  for (const option of parsed.options) {
    if (option.name === "max-args" && "argument" in option) {
      maxArgs = parseInteger(option.argument, `${XARGS.name}: -n`, 1);
    }
  }
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  return {
    options: {
      maxArgs,
      nullSeparated: has("null"),
      skipWhenEmpty: has("no-run-if-empty"),
      verbose: has("verbose"),
    },
    operands: parsed.operands,
  };
}

async function collectArguments(
  context: ShellCommandContext,
  input: ReadableStream<Uint8Array>,
  nullSeparated: boolean,
): Promise<{ readonly values: readonly string[]; readonly release: () => void }> {
  const values: string[] = [];
  let heldBytes = 0;
  let release: () => void = () => undefined;
  const take = (value: string): void => {
    if (value.length === 0) return;
    context.budget.step();
    values.push(value);
    heldBytes += utf8ByteLength(value);
    release();
    release = context.budget.buffered(heldBytes);
  };
  const consume = (chunk: string, final: boolean): string => {
    const parts = nullSeparated ? chunk.split("\0") : chunk.split(/[ \t\n]+/u);
    const remainder = final ? "" : (parts.pop() ?? "");
    for (const value of parts) take(value);
    return remainder;
  };
  try {
    let carry = "";
    for await (const line of readTextLines(context, input)) carry = consume(carry + line, false);
    consume(carry, true);
    return { values, release };
  } catch (error) {
    release();
    throw error;
  }
}

function argumentBatches(values: readonly string[], maximum: number | undefined): string[][] {
  if (maximum === undefined || values.length === 0) return [[...values]];
  const batches: string[][] = [];
  for (let index = 0; index < values.length; index += maximum) {
    batches.push(values.slice(index, index + maximum));
  }
  return batches;
}

async function runBatches(
  context: ShellCommandContext,
  fds: ShellFileDescriptors,
  command: readonly string[],
  batches: readonly (readonly string[])[],
  options: Pick<XargsOptions, "skipWhenEmpty" | "verbose">,
): Promise<number> {
  let status = 0;
  for (const batch of batches) {
    if (batch.length === 0 && options.skipWhenEmpty) continue;
    const invocation = [...command, ...batch];
    if (options.verbose) await writeText(fds[2], `${invocation.join(" ")}\n`);
    const exitCode = await context.executeCommand(invocation, fds);
    if (exitCode === 255) throw new VfsError("ECANCELED", "xargs: command exited with status 255");
    if (exitCode === 126 || exitCode === 127) return exitCode;
    if (exitCode !== 0) status = 123;
  }
  return status;
}

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
  const { options, operands } = xargsOptions(argv);
  const [name = "echo", ...fixed] = operands;
  const collected = await collectArguments(context, fds[0], options.nullSeparated);
  try {
    const batches = argumentBatches(collected.values, options.maxArgs);
    return await runBatches(context, fds, [name, ...fixed], batches, options);
  } finally {
    collected.release();
  }
});
