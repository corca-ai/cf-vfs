import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import type { AwkRule as Rule, Statement } from "./awk-ast.js";
import { arrayKey, evaluate } from "./awk-evaluate.js";
import { formatAwk } from "./awk-format.js";
import { tokenizeAwk } from "./awk-lexer.js";
import { parseAwkProgram } from "./awk-parser.js";
import {
  type AwkValue,
  asNumber,
  asString,
  getArray,
  getVariable,
  inputValue,
  type AwkRuntimeState as RuntimeState,
  removeArrayEntry,
  setVariable,
  stringValue,
  truth,
  validateFieldSeparator,
} from "./awk-runtime.js";
import { BufferedTextWriter, inputStreams, readFileText, readTextLines } from "./helpers.js";

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

type Control =
  | { readonly kind: "none" }
  | { readonly kind: "break" }
  | { readonly kind: "continue" }
  | { readonly kind: "next" }
  | { readonly kind: "exit" };
const NO_CONTROL: Control = { kind: "none" };

async function executePrint(
  statement: Extract<Statement, { kind: "print" | "printf" }>,
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<void> {
  if (statement.kind === "print") {
    const values =
      statement.values.length === 0
        ? [inputValue(state.record)]
        : statement.values.map((value) => evaluate(value, state));
    const separator = asString(getVariable(state, "OFS"));
    await output.write(
      `${values.map(asString).join(separator)}${asString(getVariable(state, "ORS"))}`,
    );
    return;
  }
  const values = statement.values.map((value) => evaluate(value, state));
  await output.write(
    formatAwk(
      asString(values[0] ?? inputValue("")),
      values.slice(1),
      state.context.budget.limits.maxStdoutBytes,
    ),
  );
}

function propagatesFromLoop(control: Control): boolean {
  return control.kind !== "none" && control.kind !== "continue" && control.kind !== "break";
}

async function executeConditional(
  statement: Extract<Statement, { kind: "if" }>,
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  const branch = truth(evaluate(statement.condition, state))
    ? statement.consequent
    : statement.alternate;
  return executeStatements(branch, state, output);
}

async function executeWhile(
  statement: Extract<Statement, { kind: "while" | "do" }>,
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  let first = true;
  while (
    statement.kind === "do"
      ? first || truth(evaluate(statement.condition, state))
      : truth(evaluate(statement.condition, state))
  ) {
    first = false;
    state.context.budget.loop();
    const control = await executeStatements(statement.body, state, output);
    if (control.kind === "break") return NO_CONTROL;
    if (propagatesFromLoop(control)) return control;
  }
  return NO_CONTROL;
}

async function executeFor(
  statement: Extract<Statement, { kind: "for" }>,
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  if (statement.initialize !== undefined) evaluate(statement.initialize, state);
  while (statement.condition === undefined || truth(evaluate(statement.condition, state))) {
    state.context.budget.loop();
    const control = await executeStatements(statement.body, state, output);
    if (control.kind === "break") return NO_CONTROL;
    if (propagatesFromLoop(control)) return control;
    if (statement.update !== undefined) evaluate(statement.update, state);
  }
  return NO_CONTROL;
}

async function executeForIn(
  statement: Extract<Statement, { kind: "for-in" }>,
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  for (const key of [...getArray(state, statement.array).keys()]) {
    state.context.budget.loop();
    setVariable(state, statement.variable, inputValue(key));
    const control = await executeStatements(statement.body, state, output);
    if (control.kind === "break") return NO_CONTROL;
    if (propagatesFromLoop(control)) return control;
  }
  return NO_CONTROL;
}

async function executeStatement(
  statement: Statement,
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  if (statement.kind === "print" || statement.kind === "printf") {
    await executePrint(statement, state, output);
    return NO_CONTROL;
  }
  if (statement.kind === "expression") {
    evaluate(statement.expression, state);
    return NO_CONTROL;
  }
  if (statement.kind === "if") return executeConditional(statement, state, output);
  if (statement.kind === "while" || statement.kind === "do")
    return executeWhile(statement, state, output);
  if (statement.kind === "for") return executeFor(statement, state, output);
  if (statement.kind === "for-in") return executeForIn(statement, state, output);
  if (statement.kind === "delete") {
    const array = getArray(state, statement.target.name);
    removeArrayEntry(state, array, arrayKey(statement.target.indices, state));
    return NO_CONTROL;
  }
  if (statement.kind === "break" || statement.kind === "continue" || statement.kind === "next") {
    return { kind: statement.kind };
  }
  if (statement.status !== undefined) {
    state.exitStatus = Math.trunc(asNumber(evaluate(statement.status, state))) & 0xff;
  }
  return { kind: "exit" };
}

async function executeStatements(
  statements: readonly Statement[],
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  for (const statement of statements) {
    state.context.budget.step();
    const control = await executeStatement(statement, state, output);
    if (control.kind !== "none") return control;
  }
  return NO_CONTROL;
}

function ruleMatches(rule: Rule, state: RuntimeState): boolean {
  if (rule.rangeEnd === undefined) {
    return rule.pattern === undefined || truth(evaluate(rule.pattern, state));
  }
  const active = state.activeRanges.has(rule);
  if (!active && rule.pattern !== undefined && !truth(evaluate(rule.pattern, state))) return false;
  if (!active) state.activeRanges.add(rule);
  if (truth(evaluate(rule.rangeEnd, state))) state.activeRanges.delete(rule);
  return true;
}

async function executeRule(
  rule: Rule,
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  if (rule.action === undefined) {
    await output.write(`${state.record}${asString(getVariable(state, "ORS"))}`);
    return NO_CONTROL;
  }
  const control = await executeStatements(rule.action, state, output);
  if (control.kind === "break" || control.kind === "continue") {
    throw new VfsError("EINVAL", `awk: ${control.kind} is not inside a loop`);
  }
  return control;
}

async function executeRules(
  rules: readonly Rule[],
  phase: Rule["phase"],
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  for (const rule of rules) {
    if (rule.phase !== phase || !ruleMatches(rule, state)) continue;
    const control = await executeRule(rule, state, output);
    if (control.kind !== "none") return control;
  }
  return NO_CONTROL;
}

function assignment(value: string): readonly [string, AwkValue] {
  const parsed = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(value);
  if (parsed === null) throw appletUsageError(AWK, `invalid assignment: ${value}`);
  const name = parsed[1] ?? "";
  if (["NR", "FNR", "NF", "FILENAME"].includes(name)) {
    throw appletUsageError(AWK, `cannot initialize ${name}`);
  }
  return [name, inputValue(parsed[2] ?? "")];
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
    if (option.name === "field-separator") variables.set("FS", stringValue(option.argument));
    else if (option.name === "assign") {
      const [name, value] = assignment(option.argument);
      variables.set(name, value);
    }
  }
  return variables;
}

function runtimeState(
  context: ShellCommandContext,
  variables: Map<string, AwkValue>,
): RuntimeState {
  return {
    context,
    variables,
    arrays: new Map(),
    regexCache: new Map(),
    activeRanges: new Set(),
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
  input: ShellFileDescriptors[0],
  output: BufferedTextWriter,
): Promise<boolean> {
  for await (const source of inputStreams(state.context, paths, input)) {
    state.filename = source.name;
    state.fnr = 0;
    for await (const line of readTextLines(state.context, source.stream, source.name)) {
      state.record = line.endsWith("\n") ? line.slice(0, -1) : line;
      state.fields = [];
      state.fieldsValid = false;
      state.fieldSeparator = asString(getVariable(state, "FS"));
      state.nr += 1;
      state.fnr += 1;
      if ((await executeRules(rules, "record", state, output)).kind === "exit") return true;
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
  const rules = parseAwkProgram(
    tokenizeAwk(source),
    context.budget.limits.maxAstNodes,
    context.budget.limits.maxNestingDepth,
  );
  const state = runtimeState(context, initialVariables(parsed.options));
  validateRuntime(state);
  const output = new BufferedTextWriter(context, fds[1]);
  const needsInput = rules.some((rule) => rule.phase !== "begin");
  try {
    const begin = await executeRules(rules, "begin", state, output);
    if (begin.kind === "next") throw new VfsError("EINVAL", "awk: next is not valid in BEGIN");
    if (begin.kind !== "exit" && needsInput)
      await executeInput(rules, operands, state, fds[0], output);
    const end = await executeRules(rules, "end", state, output);
    if (end.kind === "next") throw new VfsError("EINVAL", "awk: next is not valid in END");
    await output.flush();
    return state.exitStatus;
  } finally {
    output.abort();
    state.arrayRelease();
  }
});
