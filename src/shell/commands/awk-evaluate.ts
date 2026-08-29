import { VfsError } from "../../core/errors.js";
import type { PosixRegex } from "../../core/posix-regex.js";
import type { Expression, LValue } from "./awk-ast.js";
import { formatAwk } from "./awk-format.js";
import {
  type AwkString,
  type AwkValue,
  asNumber,
  asString,
  clearArray,
  compareAwkValues as compare,
  compiledRegex,
  fieldIndex,
  getArray,
  getField,
  getVariable,
  inputValue,
  putArray,
  type AwkRuntimeState as RuntimeState,
  setField,
  setVariable,
  splitByRegex,
  splitText,
  stringValue,
  truth,
  validateFieldSeparator,
} from "./awk-runtime.js";

export function arrayKey(indices: readonly Expression[], state: RuntimeState): string {
  const separator = asString(getVariable(state, "SUBSEP"));
  return indices.map((index) => asString(evaluate(index, state))).join(separator);
}

type ResolvedLValue =
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "field"; readonly index: number }
  | { readonly kind: "array"; readonly name: string; readonly key: string };

function resolveLValue(target: LValue, state: RuntimeState): ResolvedLValue {
  if (target.kind === "variable") return target;
  if (target.kind === "field")
    return { kind: "field", index: fieldIndex(evaluate(target.index, state)) };
  return { kind: "array", name: target.name, key: arrayKey(target.indices, state) };
}

function readResolved(target: ResolvedLValue, state: RuntimeState): AwkValue {
  if (target.kind === "variable") return getVariable(state, target.name);
  if (target.kind === "field") return getField(state, target.index);
  const array = getArray(state, target.name);
  const key = target.key;
  const value = array.get(key);
  if (value !== undefined) return value;
  const empty = inputValue("");
  putArray(state, target.name, key, empty);
  return empty;
}

function writeResolved(target: ResolvedLValue, value: AwkValue, state: RuntimeState): void {
  if (target.kind === "variable") setVariable(state, target.name, value);
  else if (target.kind === "field") setField(state, target.index, value);
  else putArray(state, target.name, target.key, value);
}

function readLValue(target: LValue, state: RuntimeState): AwkValue {
  return readResolved(resolveLValue(target, state), state);
}

function dynamicRegex(value: AwkValue, state: RuntimeState): PosixRegex {
  const source = asString(value);
  if (source === "")
    throw new VfsError("EINVAL", "awk: empty dynamic regular expressions are unsupported");
  return compiledRegex(state, source);
}

function expressionRegex(expression: Expression, state: RuntimeState): PosixRegex {
  if (expression.kind === "regex") {
    state.context.budget.step();
    return expression.pattern;
  }
  return dynamicRegex(evaluate(expression, state), state);
}

function replacementText(replacement: string, matched: string, maximumCharacters: number): string {
  let output = "";
  const append = (value: string): void => {
    if (output.length + value.length > maximumCharacters)
      throw new VfsError("E2BIG", "awk: substitution exceeds the expansion limit");
    output += value;
  };
  for (let index = 0; index < replacement.length; index += 1) {
    const character = replacement[index] ?? "";
    if (character === "&") append(matched);
    else if (character === "\\" && replacement[index + 1] === "&") {
      append("&");
      index += 1;
    } else if (character === "\\" && replacement[index + 1] === "\\") {
      append("\\");
      index += 1;
    } else append(character);
  }
  return output;
}

function substitute(
  source: string,
  pattern: PosixRegex,
  replacement: string,
  global: boolean,
  state: RuntimeState,
): { readonly value: string; readonly count: number } {
  let output = "";
  let offset = 0;
  let count = 0;
  const maximumCharacters = state.context.budget.limits.maxExpansionChars;
  const append = (value: string): void => {
    if (output.length + value.length > maximumCharacters)
      throw new VfsError("E2BIG", "awk: substitution exceeds the expansion limit");
    output += value;
  };
  for (;;) {
    state.context.budget.step();
    const match = pattern.exec(source, offset);
    if (match === undefined) break;
    const matched = source.slice(match.index, match.end);
    append(source.slice(offset, match.index));
    append(replacementText(replacement, matched, maximumCharacters - output.length));
    count += 1;
    if (!global) {
      offset = match.end;
      break;
    }
    if (match.end > match.index) {
      offset = match.end;
      continue;
    }
    const next = source.codePointAt(match.end);
    if (next === undefined) {
      offset = match.end;
      break;
    }
    const character = String.fromCodePoint(next);
    append(character);
    offset = match.end + character.length;
  }
  append(source.slice(offset));
  state.context.budget.expansionWork(output.length);
  return { value: output, count };
}

function arrayLengthCall(
  arguments_: readonly Expression[],
  state: RuntimeState,
): number | undefined {
  const argument = arguments_[0];
  return arguments_.length === 1 && argument?.kind === "variable" && state.arrays.has(argument.name)
    ? getArray(state, argument.name).size
    : undefined;
}

function matchCall(arguments_: readonly Expression[], state: RuntimeState): number {
  const [sourceExpression, patternExpression] = arguments_;
  if (
    arguments_.length !== 2 ||
    sourceExpression === undefined ||
    patternExpression === undefined
  ) {
    throw new VfsError("EINVAL", "awk: match expects two arguments");
  }
  const source = asString(evaluate(sourceExpression, state));
  const found = expressionRegex(patternExpression, state).exec(source);
  if (found === undefined) {
    setVariable(state, "RSTART", 0);
    setVariable(state, "RLENGTH", -1);
    return 0;
  }
  const start = [...source.slice(0, found.index)].length + 1;
  setVariable(state, "RSTART", start);
  setVariable(state, "RLENGTH", [...source.slice(found.index, found.end)].length);
  return start;
}

function splitCallFields(
  source: string,
  separatorExpression: Expression | undefined,
  state: RuntimeState,
): AwkString[] {
  if (separatorExpression?.kind === "regex") {
    const pattern = expressionRegex(separatorExpression, state);
    if (pattern.test("")) {
      throw new VfsError("EINVAL", "awk: an empty-matching split separator is unsupported");
    }
    return source === "" ? [] : splitByRegex(state, source, pattern);
  }
  const separator =
    separatorExpression === undefined
      ? asString(getVariable(state, "FS"))
      : asString(evaluate(separatorExpression, state));
  validateFieldSeparator(state, separator);
  return splitText(state, source, separator);
}

function splitCall(arguments_: readonly Expression[], state: RuntimeState): number {
  const [sourceExpression, target, separatorExpression] = arguments_;
  if (
    arguments_.length < 2 ||
    arguments_.length > 3 ||
    sourceExpression === undefined ||
    target === undefined
  ) {
    throw new VfsError("EINVAL", "awk: split expects two or three arguments");
  }
  if (target.kind !== "variable") {
    throw new VfsError("EINVAL", "awk: split requires an array name as its second argument");
  }
  const fields = splitCallFields(
    asString(evaluate(sourceExpression, state)),
    separatorExpression,
    state,
  );
  clearArray(state, target.name);
  for (let index = 0; index < fields.length; index += 1) {
    putArray(state, target.name, String(index + 1), fields[index] ?? inputValue(""));
  }
  return fields.length;
}

function substitutionTarget(
  target: Expression | undefined,
  name: string,
  state: RuntimeState,
): ResolvedLValue | undefined {
  if (target === undefined) return undefined;
  if (target.kind !== "variable" && target.kind !== "field" && target.kind !== "array") {
    throw new VfsError("EINVAL", `awk: ${name} target is not writable`);
  }
  return resolveLValue(target, state);
}

function substitutionCall(
  name: "sub" | "gsub",
  arguments_: readonly Expression[],
  state: RuntimeState,
): number {
  const [patternExpression, replacementExpression, target] = arguments_;
  if (
    arguments_.length < 2 ||
    arguments_.length > 3 ||
    patternExpression === undefined ||
    replacementExpression === undefined
  ) {
    throw new VfsError("EINVAL", `awk: ${name} expects two or three arguments`);
  }
  const resolved = substitutionTarget(target, name, state);
  const original = resolved === undefined ? state.record : asString(readResolved(resolved, state));
  const result = substitute(
    original,
    expressionRegex(patternExpression, state),
    asString(evaluate(replacementExpression, state)),
    name === "gsub",
    state,
  );
  if (resolved === undefined) setField(state, 0, stringValue(result.value));
  else writeResolved(resolved, stringValue(result.value), state);
  return result.count;
}

function evaluateSpecialCall(
  expression: Extract<Expression, { kind: "call" }>,
  state: RuntimeState,
): AwkValue | undefined {
  if (expression.name === "length") return arrayLengthCall(expression.arguments, state);
  if (expression.name === "match") return matchCall(expression.arguments, state);
  if (expression.name === "split") return splitCall(expression.arguments, state);
  if (expression.name === "sub" || expression.name === "gsub") {
    return substitutionCall(expression.name, expression.arguments, state);
  }
  return undefined;
}

function expectArgumentCount(
  name: string,
  arguments_: readonly AwkValue[],
  minimum: number,
  maximum: number,
  description: string,
): void {
  if (arguments_.length < minimum || arguments_.length > maximum) {
    throw new VfsError("EINVAL", `awk: ${name} ${description}`);
  }
}

function builtinLength(arguments_: readonly AwkValue[], state: RuntimeState): number {
  expectArgumentCount("length", arguments_, 0, 1, "accepts at most one argument");
  return [...asString(arguments_[0] ?? inputValue(state.record))].length;
}

function builtinSubstr(arguments_: readonly AwkValue[]): AwkValue {
  expectArgumentCount("substr", arguments_, 2, 3, "expects two or three arguments");
  const points = [...asString(arguments_[0] ?? inputValue(""))];
  const start = Math.max(1, Math.trunc(asNumber(arguments_[1] ?? inputValue("")))) - 1;
  const length =
    arguments_[2] === undefined ? points.length : Math.max(0, Math.trunc(asNumber(arguments_[2])));
  return stringValue(points.slice(start, start + length).join(""));
}

function builtinIndex(arguments_: readonly AwkValue[]): number {
  expectArgumentCount("index", arguments_, 2, 2, "expects two arguments");
  const source = asString(arguments_[0] ?? inputValue(""));
  const found = source.indexOf(asString(arguments_[1] ?? inputValue("")));
  return found < 0 ? 0 : [...source.slice(0, found)].length + 1;
}

function builtinCase(name: "tolower" | "toupper", arguments_: readonly AwkValue[]): AwkValue {
  expectArgumentCount(name, arguments_, 1, 1, "expects one argument");
  const value = asString(arguments_[0] ?? inputValue(""));
  const pattern = name === "tolower" ? /[A-Z]/gu : /[a-z]/gu;
  const offset = name === "tolower" ? 32 : -32;
  return stringValue(
    value.replace(pattern, (character) => String.fromCharCode(character.charCodeAt(0) + offset)),
  );
}

function builtinSprintf(arguments_: readonly AwkValue[], state: RuntimeState): AwkValue {
  if (arguments_.length === 0) throw new VfsError("EINVAL", "awk: sprintf requires a format");
  const formatted = formatAwk(
    asString(arguments_[0] ?? inputValue("")),
    arguments_.slice(1),
    state.context.budget.limits.maxExpansionChars,
  );
  state.context.budget.expansionWork(formatted.length);
  return stringValue(formatted);
}

function callBuiltin(name: string, arguments_: readonly AwkValue[], state: RuntimeState): AwkValue {
  if (name === "length") return builtinLength(arguments_, state);
  if (name === "substr") return builtinSubstr(arguments_);
  if (name === "index") return builtinIndex(arguments_);
  if (name === "tolower" || name === "toupper") return builtinCase(name, arguments_);
  if (name === "int") {
    expectArgumentCount(name, arguments_, 1, 1, "expects one argument");
    return Math.trunc(asNumber(arguments_[0] ?? inputValue("")));
  }
  if (name === "sprintf") return builtinSprintf(arguments_, state);
  throw new VfsError("EINVAL", `awk: unsupported function ${name}`);
}

function arithmetic(operator: string, left: AwkValue, right: AwkValue): number {
  const a = asNumber(left);
  const b = asNumber(right);
  if ((operator === "/" || operator === "%") && b === 0)
    throw new VfsError("EINVAL", "awk: division by zero");
  if (operator === "+") return a + b;
  if (operator === "-") return a - b;
  if (operator === "*") return a * b;
  if (operator === "^") return a ** b;
  if (operator === "/") return a / b;
  return a % b;
}

function evaluateMembership(
  expression: Extract<Expression, { kind: "in" }>,
  state: RuntimeState,
): number {
  const values = expression.key.kind === "tuple" ? expression.key.values : [expression.key];
  const key = values
    .map((value) => asString(evaluate(value, state)))
    .join(expression.key.kind === "tuple" ? asString(getVariable(state, "SUBSEP")) : "");
  return getArray(state, expression.array).has(key) ? 1 : 0;
}

function evaluateCall(
  expression: Extract<Expression, { kind: "call" }>,
  state: RuntimeState,
): AwkValue {
  const special = evaluateSpecialCall(expression, state);
  if (special !== undefined) return special;
  const arguments_ = expression.arguments.map((argument) => evaluate(argument, state));
  return callBuiltin(expression.name, arguments_, state);
}

function evaluateUnary(
  expression: Extract<Expression, { kind: "unary" }>,
  state: RuntimeState,
): AwkValue {
  const value = evaluate(expression.operand, state);
  if (expression.operator === "!") return truth(value) ? 0 : 1;
  return expression.operator === "+" ? asNumber(value) : -asNumber(value);
}

function evaluateAssignment(
  expression: Extract<Expression, { kind: "assign" }>,
  state: RuntimeState,
): AwkValue {
  const target = resolveLValue(expression.target, state);
  const right = evaluate(expression.value, state);
  const value =
    expression.operator === "="
      ? right
      : arithmetic(expression.operator[0] ?? "+", readResolved(target, state), right);
  writeResolved(target, value, state);
  return value;
}

function evaluateUpdate(
  expression: Extract<Expression, { kind: "update" }>,
  state: RuntimeState,
): number {
  const target = resolveLValue(expression.target, state);
  const previous = asNumber(readResolved(target, state));
  const value = previous + expression.delta;
  writeResolved(target, value, state);
  return expression.prefix ? value : previous;
}

function comparisonResult(operator: string, order: number): number {
  if (operator === "==") return Number(order === 0);
  if (operator === "!=") return Number(order !== 0);
  if (operator === "<") return Number(order < 0);
  if (operator === "<=") return Number(order <= 0);
  if (operator === ">") return Number(order > 0);
  return Number(order >= 0);
}

function evaluateRegexBinary(
  expression: Extract<Expression, { kind: "binary" }>,
  left: AwkValue,
  state: RuntimeState,
): number {
  const pattern =
    expression.right.kind === "regex"
      ? expression.right.pattern
      : dynamicRegex(evaluate(expression.right, state), state);
  if (expression.right.kind === "regex") state.context.budget.step();
  const matched = pattern.test(asString(left));
  return expression.operator === "~" ? (matched ? 1 : 0) : matched ? 0 : 1;
}

function evaluateLogical(
  expression: Extract<Expression, { kind: "binary" }>,
  state: RuntimeState,
): number | undefined {
  if (expression.operator === "&&") {
    return truth(evaluate(expression.left, state)) && truth(evaluate(expression.right, state))
      ? 1
      : 0;
  }
  if (expression.operator === "||") {
    return truth(evaluate(expression.left, state)) || truth(evaluate(expression.right, state))
      ? 1
      : 0;
  }
  return undefined;
}

function evaluateBinary(
  expression: Extract<Expression, { kind: "binary" }>,
  state: RuntimeState,
): AwkValue {
  const logical = evaluateLogical(expression, state);
  if (logical !== undefined) return logical;
  const left = evaluate(expression.left, state);
  if (expression.operator === "~" || expression.operator === "!~") {
    return evaluateRegexBinary(expression, left, state);
  }
  const right = evaluate(expression.right, state);
  if (["+", "-", "*", "/", "%", "^"].includes(expression.operator)) {
    return arithmetic(expression.operator, left, right);
  }
  if (expression.operator === "concat") return stringValue(`${asString(left)}${asString(right)}`);
  return comparisonResult(expression.operator, compare(left, right));
}

export function evaluate(expression: Expression, state: RuntimeState): AwkValue {
  state.context.budget.step();
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "string":
      return stringValue(expression.value);
    case "regex":
      return expression.pattern.test(state.record) ? 1 : 0;
    case "variable":
      return getVariable(state, expression.name);
    case "field":
      return getField(state, fieldIndex(evaluate(expression.index, state)));
    case "array":
      return readLValue(expression, state);
    case "in":
      return evaluateMembership(expression, state);
    case "tuple":
      throw new VfsError("EINVAL", "awk: expression list is only valid with in");
    case "call":
      return evaluateCall(expression, state);
    case "unary":
      return evaluateUnary(expression, state);
    case "conditional":
      return truth(evaluate(expression.condition, state))
        ? evaluate(expression.consequent, state)
        : evaluate(expression.alternate, state);
    case "assign":
      return evaluateAssignment(expression, state);
    case "update":
      return evaluateUpdate(expression, state);
    case "binary":
      return evaluateBinary(expression, state);
  }
}
