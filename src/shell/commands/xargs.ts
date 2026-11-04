import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { eachLine, parseInteger, textLines, writeText } from "./helpers.js";

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
    if (value.length === 0 && !nullSeparated) return;
    if (values.length >= context.budget.limits.maxBufferedRecords) {
      throw new VfsError("E2BIG", "xargs: buffered record limit exceeded");
    }
    context.budget.step();
    values.push(value);
    heldBytes += utf8ByteLength(value);
    release();
    release = context.budget.buffered(heldBytes);
  };
  // Only `line` is split: `carry` holds no separator, so a value spanning many
  // lines is not scanned again for each of them.
  const consume = (carry: string, line: string, final: boolean): string => {
    const parts = nullSeparated ? line.split("\0") : line.split(/[ \t\n]+/u);
    parts[0] = carry + parts[0];
    const remainder = parts.pop() ?? "";
    for (const value of parts) take(value);
    if (remainder.length > context.budget.limits.maxBufferedBytes) {
      throw new VfsError("E2BIG", "xargs: buffered byte limit exceeded");
    }
    if (final && remainder !== "") take(remainder);
    return final ? "" : remainder;
  };
  try {
    let carry = "";
    await eachLine(textLines(context, input), (line) => {
      carry = consume(carry, line, false);
      return false;
    });
    consume(carry, "", true);
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
