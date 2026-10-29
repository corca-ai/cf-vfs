import { isVfsError } from "../../core/errors.js";
import { compileJq, JqRuntimeError, JqSyntaxError, parseJqArgument } from "../../core/jq.js";
import { JqEvaluationBudget } from "../../core/jq-budget.js";
import { type JsonValue, parseJsonStream, renderJson } from "../../core/json-value.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { BufferedTextWriter, inputTexts, readFileText, writeText } from "./helpers.js";
import type { ParsedUtilityOptions } from "./options.js";

type JqOption =
  | "compact"
  | "exit-status"
  | "join-output"
  | "null-input"
  | "raw-output"
  | "raw-input"
  | "slurp"
  | "sort-keys"
  | "tab"
  | "from-file"
  | "arg"
  | "argjson";

const JQ = {
  name: "jq",
  usage:
    "[-cejnrRsS] [--tab] [--arg NAME VALUE] [--argjson NAME JSON] (FILTER | -f FILE) [PATH...]",
  summary: "runs a filter over JSON input",
  options: {
    short: {
      c: { name: "compact" },
      e: { name: "exit-status" },
      j: { name: "join-output" },
      n: { name: "null-input" },
      r: { name: "raw-output" },
      R: { name: "raw-input" },
      s: { name: "slurp" },
      S: { name: "sort-keys" },
      f: { name: "from-file", argument: true },
    },
    long: {
      compact: { name: "compact" },
      "compact-output": { name: "compact" },
      "exit-status": { name: "exit-status" },
      "join-output": { name: "join-output" },
      "null-input": { name: "null-input" },
      "raw-output": { name: "raw-output" },
      "raw-input": { name: "raw-input" },
      slurp: { name: "slurp" },
      "sort-keys": { name: "sort-keys" },
      tab: { name: "tab" },
      "from-file": { name: "from-file", argument: true },
      arg: { name: "arg", argument: true },
      argjson: { name: "argjson", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<JqOption>;

/** `jq`'s own statuses for the failures this profile can produce. */
const NO_TRUE_OUTPUT = 1;
const FILTER_REJECTED = 3;
const RUNTIME_FAILED = 5;

interface JqInvocation {
  readonly filter: ReturnType<typeof compileJq> | JqSyntaxError;
  readonly paths: readonly string[];
  readonly has: (name: string) => boolean;
}

function extractBindings(argv: readonly string[], budget: JqEvaluationBudget) {
  const rest: string[] = [];
  const variables = new Map<string, JsonValue>();
  let filterSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index] ?? "";
    const [spelling, attached] = option.split(/=(.*)/su);
    if (spelling !== "--arg" && spelling !== "--argjson") {
      if (!option.startsWith("-") || option === "--") filterSeen = true;
      rest.push(option);
      continue;
    }
    if (filterSeen) throw appletUsageError(JQ, "bindings must precede the filter");
    const name = attached ?? argv[++index];
    const value = argv[++index];
    if (name === undefined || value === undefined)
      throw appletUsageError(JQ, `${spelling} requires NAME VALUE`);
    variables.set(name, bindingValue(spelling, value, budget));
  }
  return { rest, variables };
}
function bindingValue(option: string, value: string, budget: JqEvaluationBudget): JsonValue {
  if (option === "--arg") return value;
  try {
    return parseJqArgument(value, budget);
  } catch (error) {
    if (isVfsError(error) && error.code !== "EINVAL") throw error;
    throw appletUsageError(JQ, "--argjson value is not valid JSON");
  }
}
/** The filter is the first operand, or the contents of `-f FILE`, after which every operand is input. */
async function filterSource(
  context: ShellCommandContext,
  parsed: ParsedUtilityOptions<JqOption>,
  operands: string[],
): Promise<string | undefined> {
  const file = parsed.options.filter((option) => option.name === "from-file").at(-1);
  if (file === undefined || !("argument" in file)) return operands.shift();
  const read = await readFileText(context, file.argument, context.budget.limits.maxScriptBytes);
  try {
    return read.value;
  } finally {
    read.release();
  }
}

async function jqInvocation(
  context: ShellCommandContext,
  argv: readonly string[],
  budget: JqEvaluationBudget,
): Promise<JqInvocation> {
  const { rest, variables } = extractBindings(argv, budget);
  const parsed = parseAppletOptions(JQ, rest);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const operands = [...parsed.operands];
  const source = await filterSource(context, parsed, operands);
  if (source === undefined) throw appletUsageError(JQ, "missing filter");
  try {
    return { filter: compileJq(source, { variables }), paths: operands, has };
  } catch (error) {
    if (error instanceof JqSyntaxError) return { filter: error, paths: operands, has };
    throw error;
  }
}

/**
 * The values the filter runs on: each JSON value, or each line with `-R`;
 * `-s` gathers them into one array, and `-Rs` reads the input as one string.
 */
async function jqSubjects(
  context: ShellCommandContext,
  paths: readonly string[],
  fds: ShellFileDescriptors,
  budget: JqEvaluationBudget,
  has: (name: string) => boolean,
): Promise<JsonValue[]> {
  if (has("null-input")) return [null];
  const raw = has("raw-input");
  const slurp = has("slurp");
  const inputs: JsonValue[] = [];
  const collected = await inputTexts(context, paths, fds[0]);
  try {
    if (raw && slurp) return [collected.value.map((input) => input.text).join("")];
    for (const input of collected.value) {
      if (raw) {
        const lines = input.text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        inputs.push(...lines);
      } else {
        for (const value of parseJsonStream(input.text, "jq", budget)) inputs.push(value);
      }
    }
    return slurp ? [inputs] : inputs;
  } finally {
    collected.release();
  }
}

function jqRenderer(
  has: (name: string) => boolean,
  budget: JqEvaluationBudget,
): (value: JsonValue) => string {
  const rawOutput = has("raw-output") || has("join-output");
  const indent = has("tab") ? ("\t" as const) : has("compact") ? undefined : 2;
  return (value) =>
    rawOutput && typeof value === "string"
      ? value
      : renderJson(value, {
          ...(indent === undefined ? {} : { indent }),
          sortKeys: has("sort-keys"),
          budget,
        });
}

async function runJqFilter(
  context: ShellCommandContext,
  fds: ShellFileDescriptors,
  filter: ReturnType<typeof compileJq>,
  subjects: readonly JsonValue[],
  has: (name: string) => boolean,
  budget: JqEvaluationBudget,
): Promise<{ readonly status: number; readonly last: JsonValue | undefined }> {
  const output = new BufferedTextWriter(context, fds[1]);
  const render = jqRenderer(has, budget);
  let last: JsonValue | undefined;
  try {
    for (const subject of subjects) {
      let results: JsonValue[];
      try {
        results = filter.run(subject, context.budget);
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
  const budget = new JqEvaluationBudget(context.budget);
  try {
    const { filter, paths, has } = await jqInvocation(context, argv, budget);
    if (filter instanceof JqSyntaxError) {
      await writeText(fds[2], `${filter.message}\n`);
      return FILTER_REJECTED;
    }

    let subjects: JsonValue[];
    try {
      subjects = await jqSubjects(context, paths, fds, budget, has);
    } catch (error) {
      await writeText(fds[2], `${isVfsError(error) ? error.message : String(error)}\n`);
      return RUNTIME_FAILED;
    }

    const { status, last } = await runJqFilter(context, fds, filter, subjects, has, budget);
    if (status !== 0) return status;

    if (!has("exit-status")) return 0;
    // `-e` answers about the last value: absent or false-y is a non-zero status,
    // which is what makes `jq -e` usable as a shell condition.
    if (last === undefined) return 4;
    return last === null || last === false ? NO_TRUE_OUTPUT : 0;
  } finally {
    budget.release();
  }
});
