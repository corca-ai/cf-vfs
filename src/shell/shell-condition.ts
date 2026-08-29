import {
  compareDecimalIntegers,
  type NormalizedDecimalInteger,
  normalizeDecimalInteger,
} from "../core/decimal-integer.js";
import { VfsError } from "../core/errors.js";
import { compareUtf8, normalizePathPreservingTrailingSlash } from "../core/path.js";
import type { VfsStat } from "../vfs/types.js";
import { shellModeAllows } from "./access.js";
import { isCharacterDevice, isRegularFile } from "./commands/format.js";
import {
  type ExpansionRuntime,
  expandCasePattern,
  expandScalarWord,
  isShellParameterSet,
  matchesCasePattern,
} from "./expand.js";
import type { ConditionalExpression, ConditionalUnaryOperator } from "./parser.js";
import type { Runtime } from "./shell-runtime.js";
import type { ShellBudget, ShellSession } from "./types.js";

export function consumeLoopFlow(
  session: ShellSession,
): "break" | "continue" | "propagate" | "none" {
  const flow = session.flow;
  if (flow.type !== "break" && flow.type !== "continue") return "none";
  if (flow.levels > 1) {
    session.flow = { type: flow.type, levels: flow.levels - 1 };
    return "propagate";
  }
  session.flow = { type: "none" };
  return flow.type;
}

export function flowActive(session: ShellSession): boolean {
  return session.flow.type !== "none";
}

function normalizeConditionalInteger(value: string, budget: ShellBudget): NormalizedDecimalInteger {
  budget.expansionWork(value.length);
  const normalized = normalizeDecimalInteger(value);
  if (normalized === undefined) {
    throw new VfsError("EINVAL", "[[: integer expression expected");
  }
  return normalized;
}

function compareConditionalIntegers(left: string, right: string, budget: ShellBudget): number {
  return compareDecimalIntegers(
    normalizeConditionalInteger(left, budget),
    normalizeConditionalInteger(right, budget),
  );
}

/**
 * Answers a `[[ ]]` file predicate.
 *
 * The mapping is exhaustive rather than defaulted, so adding an operator to the
 * parser's list without deciding its meaning is a type error instead of
 * silently inheriting `-d`.
 */
function conditionalFileTest(
  operator: ConditionalUnaryOperator,
  stat: VfsStat,
  session: ShellSession,
): boolean {
  switch (operator) {
    case "-e":
      return true;
    case "-L":
    case "-h":
      return stat.kind === "symlink";
    case "-c":
      return isCharacterDevice(stat);
    case "-f":
      // A regular file, which a character device is not — the mode's type
      // field is the only thing that distinguishes them here.
      return stat.kind === "file" && isRegularFile(stat);
    case "-d":
      return stat.kind === "directory";
    case "-s":
      return stat.sizeBytes > 0;
    // Effective mode bits when credentials exist; compatibility fallback
    // otherwise. See the `test` profile.
    case "-r":
      return shellModeAllows(stat, session.credentials, 4);
    case "-w":
      return shellModeAllows(stat, session.credentials, 2);
    case "-x":
      return shellModeAllows(stat, session.credentials, 1);
    default:
      throw new VfsError("EINVAL", `[[: unsupported unary operator ${operator}`);
  }
}

type ConditionalLeaf = Exclude<
  ConditionalExpression,
  { type: "conditional-not" | "conditional-group" | "conditional-boolean" }
>;

type ConditionalFrame =
  | { type: "not" }
  | { type: "boolean"; operator: "&&" | "||"; right: ConditionalExpression };

function descendConditional(
  expression: ConditionalExpression,
  pending: ConditionalFrame[],
  runtime: Runtime,
): ConditionalLeaf {
  let current = expression;
  while (
    current.type === "conditional-not" ||
    current.type === "conditional-group" ||
    current.type === "conditional-boolean"
  ) {
    runtime.budget.step();
    if (current.type === "conditional-not") {
      pending.push({ type: "not" });
      current = current.expression;
    } else if (current.type === "conditional-group") {
      current = current.expression;
    } else {
      pending.push({ type: "boolean", operator: current.operator, right: current.right });
      current = current.left;
    }
  }
  runtime.budget.step();
  return current;
}

async function evaluateConditionalLeaf(
  expression: ConditionalLeaf,
  session: ShellSession,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<boolean> {
  if (expression.type === "conditional-word") {
    const value = await expandScalarWord(
      expression.word,
      session,
      runtime.fileSystem,
      runtime.budget,
      expansion,
    );
    return value.length > 0;
  }
  if (expression.type === "conditional-unary") {
    return await evaluateConditionalUnary(expression, session, runtime, expansion);
  }
  return await evaluateConditionalBinary(expression, session, runtime, expansion);
}

async function evaluateConditionalUnary(
  expression: Extract<ConditionalLeaf, { type: "conditional-unary" }>,
  session: ShellSession,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<boolean> {
  const operand = await expandScalarWord(
    expression.operand,
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion,
  );
  if (expression.operator === "-n") return operand.length > 0;
  if (expression.operator === "-z") return operand.length === 0;
  if (expression.operator === "-v") return isShellParameterSet(operand, session);
  if (operand.length === 0) return false;
  try {
    const path = normalizePathPreservingTrailingSlash(operand, session.cwd);
    const asksAboutLink = expression.operator === "-L" || expression.operator === "-h";
    const stat = asksAboutLink ? runtime.fileSystem.lstat(path) : runtime.fileSystem.stat(path);
    return conditionalFileTest(expression.operator, stat, session);
  } catch (error) {
    if (error instanceof VfsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function evaluateConditionalBinary(
  expression: Extract<ConditionalLeaf, { type: "conditional-binary" }>,
  session: ShellSession,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<boolean> {
  const left = await expandScalarWord(
    expression.left,
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion,
  );
  if (expression.operator === "==" || expression.operator === "!=") {
    const pattern = await expandCasePattern(
      expression.right,
      session,
      runtime.fileSystem,
      runtime.budget,
      expansion,
    );
    const matches = matchesCasePattern(left, pattern, runtime.budget);
    return expression.operator === "==" ? matches : !matches;
  }
  const right = await expandScalarWord(
    expression.right,
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion,
  );
  if (expression.operator === "<" || expression.operator === ">") {
    runtime.budget.expansionWork(left.length + right.length);
    const order = compareUtf8(left, right);
    return expression.operator === "<" ? order < 0 : order > 0;
  }
  return compareConditionalNumbers(expression.operator, left, right, runtime.budget);
}

function compareConditionalNumbers(
  operator: "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge",
  left: string,
  right: string,
  budget: ShellBudget,
): boolean {
  const order = compareConditionalIntegers(left, right, budget);
  if (operator === "-eq") return order === 0;
  if (operator === "-ne") return order !== 0;
  if (operator === "-lt") return order < 0;
  if (operator === "-le") return order <= 0;
  if (operator === "-gt") return order > 0;
  return order >= 0;
}

type ConditionalContinuation =
  | { done: true; value: boolean }
  | { done: false; expression: ConditionalExpression };

function resumeConditional(
  initialValue: boolean,
  pending: ConditionalFrame[],
): ConditionalContinuation {
  let value = initialValue;
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    if (frame.type === "not") {
      value = !value;
      continue;
    }
    const shortCircuited = frame.operator === "&&" ? !value : value;
    if (!shortCircuited) return { done: false, expression: frame.right };
  }
  return { done: true, value };
}

export async function evaluateConditional(
  expression: ConditionalExpression,
  session: ShellSession,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<boolean> {
  const pending: ConditionalFrame[] = [];
  let current = expression;
  while (true) {
    const leaf = descendConditional(current, pending, runtime);
    const value = await evaluateConditionalLeaf(leaf, session, runtime, expansion);
    const continuation = resumeConditional(value, pending);
    if (continuation.done) return continuation.value;
    current = continuation.expression;
  }
}
