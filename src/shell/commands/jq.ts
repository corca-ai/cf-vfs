import { isVfsError } from "../../core/errors.js";
import { compileJq, JqRuntimeError, JqSyntaxError, parseJqArgument } from "../../core/jq.js";
import { type JsonValue, parseJsonStream, renderJson } from "../../core/json-value.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { BufferedTextWriter, inputTexts, writeText } from "./helpers.js";

const JQ = {
  name: "jq",
  usage: "[-cejnrsS] [--tab] [--arg NAME VALUE] [--argjson NAME JSON] FILTER [PATH...]",
  summary: "runs a filter over JSON input",
  options: {
    short: {
      c: { name: "compact" },
      e: { name: "exit-status" },
      j: { name: "join-output" },
      n: { name: "null-input" },
      r: { name: "raw-output" },
      s: { name: "slurp" },
      S: { name: "sort-keys" },
    },
    long: {
      compact: { name: "compact" },
      "compact-output": { name: "compact" },
      "exit-status": { name: "exit-status" },
      "join-output": { name: "join-output" },
      "null-input": { name: "null-input" },
      "raw-output": { name: "raw-output" },
      slurp: { name: "slurp" },
      "sort-keys": { name: "sort-keys" },
      tab: { name: "tab" },
      arg: { name: "arg", argument: true },
      argjson: { name: "argjson", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<
  | "compact"
  | "exit-status"
  | "join-output"
  | "null-input"
  | "raw-output"
  | "slurp"
  | "sort-keys"
  | "tab"
  | "arg"
  | "argjson"
>;

/** `jq`'s own statuses for the failures this profile can produce. */
const NO_TRUE_OUTPUT = 1;
const FILTER_REJECTED = 3;
const RUNTIME_FAILED = 5;

interface JqInvocation {
  readonly filter: ReturnType<typeof compileJq> | JqSyntaxError;
  readonly paths: readonly string[];
  readonly has: (name: string) => boolean;
}

function jqInvocation(argv: readonly string[]): JqInvocation {
  const parsed = parseAppletOptions(JQ, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const valuesFor = (name: string): string[] =>
    parsed.options.flatMap((option) =>
      option.name === name && "argument" in option ? [option.argument] : [],
    );
  const operands = [...parsed.operands];
  const variables = new Map<string, JsonValue>();
  for (const name of valuesFor("arg")) {
    const value = operands.shift();
    if (value === undefined) throw appletUsageError(JQ, `--arg ${name} is missing its value`);
    variables.set(name, value);
  }
  for (const name of valuesFor("argjson")) {
    const value = operands.shift();
    if (value === undefined) throw appletUsageError(JQ, `--argjson ${name} is missing its value`);
    try {
      variables.set(name, parseJqArgument(value));
    } catch {
      throw appletUsageError(JQ, `--argjson ${name} is not valid JSON`);
    }
  }
  const source = operands.shift();
  if (source === undefined) throw appletUsageError(JQ, "missing filter");
  try {
    return { filter: compileJq(source, { variables }), paths: operands, has };
  } catch (error) {
    if (error instanceof JqSyntaxError) return { filter: error, paths: operands, has };
    throw error;
  }
}

async function jqInputs(
  context: ShellCommandContext,
  paths: readonly string[],
  fds: ShellFileDescriptors,
): Promise<JsonValue[]> {
  const inputs: JsonValue[] = [];
  const collected = await inputTexts(context, paths, fds[0]);
  try {
    for (const input of collected.value) inputs.push(...parseJsonStream(input.text, "jq"));
    return inputs;
  } finally {
    collected.release();
  }
}

function jqRenderer(has: (name: string) => boolean): (value: JsonValue) => string {
  const rawOutput = has("raw-output") || has("join-output");
  const indent = has("tab") ? ("\t" as const) : has("compact") ? undefined : 2;
  return (value) =>
    rawOutput && typeof value === "string"
      ? value
      : renderJson(value, {
          ...(indent === undefined ? {} : { indent }),
          sortKeys: has("sort-keys"),
        });
}

async function runJqFilter(
  context: ShellCommandContext,
  fds: ShellFileDescriptors,
  filter: ReturnType<typeof compileJq>,
  subjects: readonly JsonValue[],
  has: (name: string) => boolean,
): Promise<{ readonly status: number; readonly last: JsonValue | undefined }> {
  const output = new BufferedTextWriter(context, fds[1]);
  const render = jqRenderer(has);
  let last: JsonValue | undefined;
  try {
    for (const subject of subjects) {
      let results: JsonValue[];
      try {
        results = filter.run(subject);
      } catch (error) {
        if (!(error instanceof JqRuntimeError)) throw error;
        await output.flush();
        await writeText(fds[2], `${error.message}\n`);
        return { status: RUNTIME_FAILED, last };
      }
      for (const value of results) {
        last = value;
        context.budget.io(1);
        await output.write(has("join-output") ? render(value) : `${render(value)}\n`);
      }
    }
    await output.flush();
    return { status: 0, last };
  } finally {
    output.abort();
  }
}

/**
 * Runs a filter over JSON input.
 *
 * The filter language is a declared subset — see the profile in the
 * documentation — and anything outside it is refused where it is written rather
 * than approximated. That is the same stance `sed` and the regular-expression
 * subset take, and it is what lets a filter this accepts mean here what it
 * means in `jq`.
 *
 * Unlike every other utility that parses a language here, this one has an
 * oracle: `jq` is deterministic and containerized, so the profile is held to
 * recorded differential fixtures rather than to an argument.
 *
 * The whole input is read before the first output, so an opaque body is
 * `ENOTSUP` for the same reason `sort`'s is.
 */
export const jqCommand = /* @__PURE__ */ defineApplet(JQ, async (context, argv, fds) => {
  const { filter, paths, has } = jqInvocation(argv);
  if (filter instanceof JqSyntaxError) {
    await writeText(fds[2], `${filter.message}\n`);
    return FILTER_REJECTED;
  }

  let inputs: JsonValue[];
  try {
    inputs = has("null-input") ? [] : await jqInputs(context, paths, fds);
  } catch (error) {
    await writeText(fds[2], `${isVfsError(error) ? error.message : String(error)}\n`);
    return RUNTIME_FAILED;
  }

  const subjects = has("null-input") ? [null] : has("slurp") ? [inputs] : inputs;
  const { status, last } = await runJqFilter(context, fds, filter, subjects, has);
  if (status !== 0) return status;

  if (!has("exit-status")) return 0;
  // `-e` answers about the last value: absent or false-y is a non-zero status,
  // which is what makes `jq -e` usable as a shell condition.
  if (last === undefined) return 4;
  return last === null || last === false ? NO_TRUE_OUTPUT : 0;
});
