import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import type { AwkFunction, AwkRule as Rule } from "./awk-ast.js";
import { decodeAwkEscapes, tokenizeAwk } from "./awk-lexer.js";
import { parseAwkProgram } from "./awk-parser.js";
import { AwkOutput, bindExecutor, executeRules } from "./awk-program.js";
import {
  type AwkValue,
  asString,
  getVariable,
  inputValue,
  type AwkRuntimeState as RuntimeState,
  setField,
  stringValue,
  validateFieldSeparator,
} from "./awk-runtime.js";
import { retainAwkVariable } from "./awk-strings.js";
import { BufferedTextWriter, readFileText, readTextLines } from "./helpers.js";
import { inputSources } from "./inputs.js";

const AWK = {
  name: "awk",
  usage: "[-F SEPARATOR] [-v NAME=VALUE] [-f PROGRAM_FILE] [PROGRAM] [FILE...]",
  summary: "scans records with a bounded subset of the AWK language",
  options: {
    short: {
      F: { name: "field-separator", argument: true },
      v: { name: "assign", argument: true },
      f: { name: "program-file", argument: true },
    },
    stopAtFirstOperand: true,
  },
} as const satisfies AppletSpecWithOptions<"field-separator" | "assign" | "program-file">;

function assignment(value: string): readonly [string, AwkValue] {
  const parsed = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(value);
  if (parsed === null) throw appletUsageError(AWK, `invalid assignment: ${value}`);
  const name = parsed[1] ?? "";
  if (["NR", "FNR", "NF", "FILENAME"].includes(name)) {
    throw appletUsageError(AWK, `cannot initialize ${name}`);
  }
  return [name, inputValue(decodeAwkEscapes(parsed[2] ?? ""))];
}

interface AwkOptionValue {
  readonly name: string;
  readonly argument?: string;
}

async function readProgramFiles(
  context: ShellCommandContext,
  paths: readonly string[],
): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const separatorBytes = chunks.length === 0 ? 0 : 1;
    if (bytes + separatorBytes > context.budget.limits.maxScriptBytes) {
      throw new VfsError("E2BIG", "awk: program byte limit exceeded", path);
    }
    const lease = await readFileText(
      context,
      path,
      context.budget.limits.maxScriptBytes - bytes - separatorBytes,
    );
    try {
      if (lease.value.includes("\0")) {
        throw new VfsError("EINVAL", "awk: program file contains a NUL byte", path);
      }
      bytes += utf8ByteLength(lease.value) + separatorBytes;
      chunks.push(lease.value);
    } finally {
      lease.release();
    }
  }
  return chunks.join("\n");
}

async function programSource(
  context: ShellCommandContext,
  files: readonly string[],
  operands: string[],
): Promise<string> {
  if (files.length > 0) return readProgramFiles(context, files);
  const source = operands.shift();
  if (source === undefined) throw appletUsageError(AWK, "missing program");
  return source;
}

function validateProgram(
  source: string,
  operands: readonly string[],
  context: ShellCommandContext,
): void {
  if (source.includes("\0")) throw new VfsError("EINVAL", "awk: program contains a NUL byte");
  if (operands.some((value) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value))) {
    throw appletUsageError(AWK, "assignments after the program are unsupported; use -v");
  }
  if (utf8ByteLength(source) > context.budget.limits.maxScriptBytes) {
    throw new VfsError("E2BIG", "awk: program byte limit exceeded");
  }
}

function initialVariables(options: readonly AwkOptionValue[]): Map<string, AwkValue> {
  const variables = new Map<string, AwkValue>([
    ["FS", stringValue(" ")],
    ["OFS", stringValue(" ")],
    ["ORS", stringValue("\n")],
    ["RS", stringValue("\n")],
    ["OFMT", stringValue("%.6g")],
    ["CONVFMT", stringValue("%.6g")],
    ["SUBSEP", stringValue("\x1c")],
    ["RSTART", 0],
    ["RLENGTH", -1],
  ]);
  for (const option of options) {
    if (option.argument === undefined) continue;
    if (option.name === "field-separator") {
      // `-F '\t'` names a tab, as POSIX awk processes escapes in the value.
      variables.set("FS", stringValue(decodeAwkEscapes(option.argument)));
    } else if (option.name === "assign") {
      const [name, value] = assignment(option.argument);
      variables.set(name, value);
    }
  }
  return variables;
}

function runtimeState(
  context: ShellCommandContext,
  variables: Map<string, AwkValue>,
  functions: ReadonlyMap<string, AwkFunction>,
): RuntimeState {
  return {
    context,
    functions,
    frames: [],
    callFunction: () => {
      throw new VfsError("EIO", "awk: no executor is bound");
    },
    closeOutput: () => -1,
    variables,
    arrays: new Map(),
    regexCache: new Map(),
    activeRanges: new Set(),
    scalarSizes: new Map(),
    scalarBytes: 0,
    scalarRelease: () => undefined,
    arrayEntries: 0,
    arrayBytes: 0,
    arrayRelease: () => undefined,
    record: "",
    fields: [],
    fieldsValid: false,
    fieldSeparator: " ",
    nr: 0,
    fnr: 0,
    filename: "",
    exitStatus: 0,
  };
}

function validateRuntime(state: RuntimeState): void {
  if (asString(getVariable(state, "RS")) !== "\n") {
    throw new VfsError("ENOTSUP", "awk: record separators other than newline are unsupported");
  }
  if (
    asString(getVariable(state, "OFMT")) !== "%.6g" ||
    asString(getVariable(state, "CONVFMT")) !== "%.6g"
  ) {
    throw new VfsError("ENOTSUP", "awk: changing OFMT or CONVFMT is unsupported");
  }
  validateFieldSeparator(state, asString(getVariable(state, "FS")));
}

async function executeInput(
  rules: readonly Rule[],
  paths: readonly string[],
  state: RuntimeState,
  fds: ShellFileDescriptors,
  output: AwkOutput,
  writer: BufferedTextWriter,
): Promise<boolean> {
  const input = fds[0];
  for await (const operand of inputSources(state.context, paths, input)) {
    state.filename = operand.name;
    state.fnr = 0;
    for await (const line of readTextLines(state.context, operand.source, operand.name)) {
      setField(state, 0, inputValue(line.endsWith("\n") ? line.slice(0, -1) : line));
      state.fields = [];
      state.fieldsValid = false;
      state.fieldSeparator = asString(getVariable(state, "FS"));
      state.nr += 1;
      state.fnr += 1;
      const control = await executeRules(rules, "record", state, output, writer, fds[2]);
      if (control.kind === "exit") return true;
    }
  }
  return false;
}

/**
 * Runs the bounded, streaming AWK profile.
 *
 * The program is compiled before an input stream is opened, so malformed or
 * unsupported syntax cannot consume stdin or expose a partial output. Every
 * record and expression spends the caller's ordinary shell budget, and the
 * shared line reader supplies UTF-8, cancellation, I/O, and record bounds.
 */
export const awkCommand = /* @__PURE__ */ defineApplet(AWK, async (context, argv, fds) => {
  const parsed = parseAppletOptions(AWK, argv);
  const programFiles = parsed.options
    .filter((option) => option.name === "program-file" && "argument" in option)
    .map((option) => ("argument" in option ? option.argument : ""));
  const operands = [...parsed.operands];
  const source = await programSource(context, programFiles, operands);
  validateProgram(source, operands, context);
  const program = parseAwkProgram(
    tokenizeAwk(source),
    context.budget.limits.maxAstNodes,
    context.budget.limits.maxNestingDepth,
  );
  const { rules } = program;
  const state = runtimeState(context, initialVariables(parsed.options), program.functions);
  validateRuntime(state);
  const writer = new BufferedTextWriter(context, fds[1]);
  const output = new AwkOutput(context);
  bindExecutor(state, output);
  const needsInput = rules.some((rule) => rule.phase !== "begin");
  try {
    for (const [name, value] of state.variables) retainAwkVariable(state, name, value);
    const begin = await executeRules(rules, "begin", state, output, writer, fds[2]);
    if (begin.kind === "next") throw new VfsError("EINVAL", "awk: next is not valid in BEGIN");
    if (begin.kind !== "exit" && needsInput)
      await executeInput(rules, operands, state, fds, output, writer);
    const end = await executeRules(rules, "end", state, output, writer, fds[2]);
    if (end.kind === "next") throw new VfsError("EINVAL", "awk: next is not valid in END");
    await writer.flush();
    await output.writeFiles();
    return state.exitStatus;
  } finally {
    writer.abort();
    state.arrayRelease();
    state.scalarRelease();
  }
});
