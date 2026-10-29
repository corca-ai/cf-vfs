import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { ShellCommandContext, ShellSink } from "../types.js";
import type { AwkFunction, Expression, AwkRule as Rule, Statement } from "./awk-ast.js";
import { arrayKey, evaluate } from "./awk-evaluate.js";
import { formatAwk } from "./awk-format.js";
import {
  type AwkFrameEntry,
  type AwkValue,
  asNumber,
  asString,
  bindsByReference,
  clearArray,
  getArray,
  getVariable,
  inputValue,
  type AwkRuntimeState as RuntimeState,
  removeArrayEntry,
  setVariable,
  truth,
} from "./awk-runtime.js";
import { joinAwkStrings } from "./awk-strings.js";
import { type BufferedTextWriter, commandPath, writeText } from "./helpers.js";

export type Control =
  | { readonly kind: "none" }
  | { readonly kind: "break" }
  | { readonly kind: "continue" }
  | { readonly kind: "next" }
  | { readonly kind: "exit" }
  | { readonly kind: "return"; readonly value: AwkValue };
const NO_CONTROL: Control = { kind: "none" };

/** `next` or `exit` inside a function, carried out through the calling expression. */
class AwkControlSignal extends Error {
  constructor(readonly control: Control) {
    super(`awk: ${control.kind}`);
  }
}

interface AwkFile {
  append: boolean;
  chunks: string[];
  closed: boolean;
}

/**
 * Output produced while statements run synchronously: standard output and
 * error between rule flushes, and redirected files until the run ends. A
 * file named with `>` is replaced once per run and `>>` appends, as AWK keeps
 * an output open until `close`. Everything held counts against the buffered
 * byte limit.
 */
export class AwkOutput {
  stdout: string[] = [];
  stderr: string[] = [];
  readonly files = new Map<string, AwkFile>();
  private held = 0;

  constructor(private readonly context: ShellCommandContext) {}

  emit(
    text: string,
    destination: { readonly name: string; readonly append: boolean } | undefined,
  ): void {
    this.held += utf8ByteLength(text);
    if (this.held > this.context.budget.limits.maxBufferedBytes) {
      throw new VfsError("E2BIG", "awk: buffered output limit exceeded");
    }
    const name = destination?.name;
    if (name === undefined || name === "/dev/stdout" || name === "-") this.stdout.push(text);
    else if (name === "/dev/stderr") this.stderr.push(text);
    else this.file(name, destination?.append ?? false).chunks.push(text);
  }

  close(name: string): number {
    const file = this.files.get(name);
    if (file === undefined) return -1;
    file.closed = true;
    return 0;
  }

  async flush(writer: BufferedTextWriter, stderr: ShellSink): Promise<void> {
    const [out, err] = [this.stdout.join(""), this.stderr.join("")];
    this.held -= utf8ByteLength(out) + utf8ByteLength(err);
    this.stdout = [];
    this.stderr = [];
    if (out !== "") await writer.write(out);
    if (err !== "") await writeText(stderr, err);
  }

  /** Publishes each redirected file once, replacing or appending as it was opened. */
  async writeFiles(): Promise<void> {
    for (const [name, file] of this.files) {
      const path = commandPath(this.context, name);
      const body = file.chunks.join("");
      if (file.append && this.context.fileSystem.inspectWriteTarget(path, true) !== null) {
        await this.context.fileSystem.appendFile(path, body);
      } else await this.context.fileSystem.writeFile(path, body);
    }
  }

  private file(name: string, append: boolean): AwkFile {
    let file = this.files.get(name);
    if (file === undefined) {
      file = { append, chunks: [], closed: false };
      this.files.set(name, file);
    } else if (file.closed) {
      // Reopening after `close`: `>` starts the file again, `>>` keeps it.
      if (!append) {
        file.chunks = [];
        file.append = false;
      }
      file.closed = false;
    }
    return file;
  }
}

function executePrint(
  statement: Extract<Statement, { kind: "print" | "printf" }>,
  state: RuntimeState,
  output: AwkOutput,
): void {
  const destination =
    statement.destination === undefined
      ? undefined
      : {
          name: asString(evaluate(statement.destination.target, state)),
          append: statement.destination.append,
        };
  if (statement.kind === "print") {
    const values =
      statement.values.length === 0
        ? [inputValue(state.record)]
        : statement.values.map((value) => evaluate(value, state));
    const separator = asString(getVariable(state, "OFS"));
    output.emit(
      joinAwkStrings(state, [
        joinAwkStrings(state, values.map(asString), separator),
        asString(getVariable(state, "ORS")),
      ]),
      destination,
    );
    return;
  }
  const values = statement.values.map((value) => evaluate(value, state));
  output.emit(
    formatAwk(
      asString(values[0] ?? inputValue("")),
      values.slice(1),
      state.context.budget.limits.maxStdoutBytes,
    ),
    destination,
  );
}

function propagatesFromLoop(control: Control): boolean {
  return control.kind !== "none" && control.kind !== "continue" && control.kind !== "break";
}

/** Loop iterations charge expansion work, which bounds them without a shell allowance. */
function loopBody(
  statements: readonly Statement[],
  state: RuntimeState,
  output: AwkOutput,
): Control | undefined {
  state.context.budget.expansionWork(1);
  const control = executeStatements(statements, state, output);
  if (control.kind === "break") return NO_CONTROL;
  return propagatesFromLoop(control) ? control : undefined;
}

function executeWhile(
  statement: Extract<Statement, { kind: "while" | "do" }>,
  state: RuntimeState,
  output: AwkOutput,
): Control {
  let first = statement.kind === "do";
  while (first || truth(evaluate(statement.condition, state))) {
    first = false;
    const control = loopBody(statement.body, state, output);
    if (control !== undefined) return control;
  }
  return NO_CONTROL;
}

function executeFor(
  statement: Extract<Statement, { kind: "for" }>,
  state: RuntimeState,
  output: AwkOutput,
): Control {
  if (statement.initialize !== undefined) evaluate(statement.initialize, state);
  while (statement.condition === undefined || truth(evaluate(statement.condition, state))) {
    const control = loopBody(statement.body, state, output);
    if (control !== undefined) return control;
    if (statement.update !== undefined) evaluate(statement.update, state);
  }
  return NO_CONTROL;
}

function executeForIn(
  statement: Extract<Statement, { kind: "for-in" }>,
  state: RuntimeState,
  output: AwkOutput,
): Control {
  for (const key of [...getArray(state, statement.array).keys()]) {
    setVariable(state, statement.variable, inputValue(key));
    const control = loopBody(statement.body, state, output);
    if (control !== undefined) return control;
  }
  return NO_CONTROL;
}

function executeStatement(statement: Statement, state: RuntimeState, output: AwkOutput): Control {
  switch (statement.kind) {
    case "print":
    case "printf":
      executePrint(statement, state, output);
      return NO_CONTROL;
    case "expression":
      evaluate(statement.expression, state);
      return NO_CONTROL;
    case "if":
      return executeStatements(
        truth(evaluate(statement.condition, state)) ? statement.consequent : statement.alternate,
        state,
        output,
      );
    case "while":
    case "do":
      return executeWhile(statement, state, output);
    case "for":
      return executeFor(statement, state, output);
    case "for-in":
      return executeForIn(statement, state, output);
    case "delete": {
      const array = getArray(state, statement.target.name);
      removeArrayEntry(state, array, arrayKey(statement.target.indices, state));
      return NO_CONTROL;
    }
    case "delete-array":
      clearArray(state, statement.name);
      return NO_CONTROL;
    case "break":
    case "continue":
    case "next":
      return { kind: statement.kind };
    case "return":
      return {
        kind: "return",
        value: statement.value === undefined ? inputValue("") : evaluate(statement.value, state),
      };
    case "exit":
      if (statement.status !== undefined) {
        state.exitStatus = Math.trunc(asNumber(evaluate(statement.status, state))) & 0xff;
      }
      return { kind: "exit" };
  }
}

function executeStatements(
  statements: readonly Statement[],
  state: RuntimeState,
  output: AwkOutput,
): Control {
  // Statements run once per record or per loop iteration, which the I/O
  // limit and expansion work bound, so they charge no step of their own.
  for (const statement of statements) {
    const control = executeStatement(statement, state, output);
    if (control.kind !== "none") return control;
  }
  return NO_CONTROL;
}

function runFunction(definition: AwkFunction, state: RuntimeState, output: AwkOutput): AwkValue {
  const control = executeStatements(definition.body, state, output);
  if (control.kind === "return") return control.value;
  if (control.kind === "next" || control.kind === "exit") throw new AwkControlSignal(control);
  if (control.kind !== "none") {
    throw new VfsError("EINVAL", `awk: ${control.kind} is not inside a loop`);
  }
  return inputValue("");
}

/** Binds arguments to a fresh frame and runs the function, bounded by the function depth. */
function callUserFunction(
  expression: Extract<Expression, { kind: "user-call" }>,
  state: RuntimeState,
  output: AwkOutput,
): AwkValue {
  const definition = state.functions.get(expression.name);
  if (definition === undefined) {
    throw new VfsError("EINVAL", `awk: calling undefined function ${expression.name}`);
  }
  if (expression.arguments.length > definition.parameters.length) {
    throw new VfsError("EINVAL", `awk: function ${expression.name} called with too many arguments`);
  }
  if (state.frames.length >= state.context.budget.limits.maxFunctionDepth) {
    throw new VfsError("E2BIG", "awk: function call depth limit exceeded");
  }
  state.context.budget.expansionWork(1);
  const frame = new Map<string, AwkFrameEntry>();
  definition.parameters.forEach((parameter, index) => {
    const argument = expression.arguments[index];
    if (argument === undefined) {
      frame.set(parameter, { kind: "scalar", value: inputValue(""), assigned: false });
    } else if (argument.kind === "variable" && bindsByReference(state, argument.name)) {
      frame.set(parameter, { kind: "alias", name: argument.name, depth: state.frames.length });
    } else {
      frame.set(parameter, { kind: "scalar", value: evaluate(argument, state), assigned: true });
    }
  });
  state.frames.push(frame);
  try {
    return runFunction(definition, state, output);
  } finally {
    state.frames.pop();
  }
}

/** Connects function calls and `close` in expressions to this run's executor. */
export function bindExecutor(state: RuntimeState, output: AwkOutput): void {
  state.callFunction = (call) => callUserFunction(call, state, output);
  state.closeOutput = (name) => output.close(name);
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

function executeRule(rule: Rule, state: RuntimeState, output: AwkOutput): Control {
  try {
    if (!ruleMatches(rule, state)) return NO_CONTROL;
    if (rule.action === undefined) {
      output.emit(`${state.record}${asString(getVariable(state, "ORS"))}`, undefined);
      return NO_CONTROL;
    }
    const control = executeStatements(rule.action, state, output);
    if (control.kind === "break" || control.kind === "continue" || control.kind === "return") {
      throw new VfsError("EINVAL", `awk: ${control.kind} is not valid here`);
    }
    return control;
  } catch (error) {
    if (error instanceof AwkControlSignal) return error.control;
    throw error;
  }
}

/** Runs the rules of one phase, flushing what each rule printed before the next. */
export async function executeRules(
  rules: readonly Rule[],
  phase: Rule["phase"],
  state: RuntimeState,
  output: AwkOutput,
  writer: BufferedTextWriter,
  stderr: ShellSink,
): Promise<Control> {
  for (const rule of rules) {
    if (rule.phase !== phase) continue;
    const control = executeRule(rule, state, output);
    await output.flush(writer, stderr);
    if (control.kind !== "none") return control;
  }
  return NO_CONTROL;
}
