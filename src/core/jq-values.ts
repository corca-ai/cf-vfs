import type { JqEvaluationBudget } from "./jq-budget.js";
import { JqRuntimeError, JqSyntaxError } from "./jq-errors.js";
import type { JqBinaryOperator as BinaryOperator } from "./jq-parser.js";
import {
  compareJson,
  equalJson,
  isJsonNumber,
  isTruthy,
  type JsonObject,
  type JsonValue,
  jsonKind,
  numberOf,
  renderJson,
} from "./json-value.js";
import { codePointLength } from "./unicode.js";

export const SKIP = Symbol("skip");

export function nullaryBuiltin(
  name: string,
  input: JsonValue,
  budget: JqEvaluationBudget,
): JsonValue | typeof SKIP {
  switch (name) {
    case "empty":
      return SKIP;
    case "not":
      return !isTruthy(input);
    case "type":
      return jsonKind(input);
    case "length":
      return lengthOf(input);
    case "keys":
      return [...keysOf(input)].sort((a, b) => compareJson(a, b, budget));
    case "keys_unsorted":
      return keysOf(input);
    case "values":
      return input === null ? SKIP : input;
    case "add":
      return sumValues(input, budget);
    case "tostring":
      return typeof input === "string" ? input : renderJson(input, { budget });
    case "tonumber":
      return numberValue(input);
    case "sort":
      return [...requireArray(input, "sort")].sort((a, b) => compareJson(a, b, budget));
    case "unique":
      return uniqueValues(input, budget);
    case "min":
    case "max":
      return extremeValue(input, name, budget);
    case "reverse":
      return [...requireArray(input, "reverse")].reverse();
    case "first":
      return requireArray(input, "first").at(0) ?? null;
    case "last":
      return requireArray(input, "last").at(-1) ?? null;
    case "any":
      return requireArray(input, "any").some(isTruthy);
    case "all":
      return requireArray(input, "all").every(isTruthy);
    case "to_entries":
      return toEntries(input);
    case "from_entries":
      return fromEntries(input);
    case "flatten":
      return flatten(requireArray(input, "flatten"), 1e9, budget);
    default:
      throw new JqSyntaxError(`jq: ${name}/0 is not a function in this profile`);
  }
}

function sumValues(input: JsonValue, budget: JqEvaluationBudget): JsonValue {
  let total: JsonValue = null;
  for (const item of requireArray(input, "add")) total = applyBinary("+", total, item, budget);
  return total;
}

function numberValue(input: JsonValue): JsonValue {
  if (isJsonNumber(input)) return input;
  if (typeof input !== "string") {
    throw new JqRuntimeError(`jq: cannot convert ${jsonKind(input)} to a number`);
  }
  const parsed = Number(input.trim());
  if (input.trim() === "" || Number.isNaN(parsed)) {
    throw new JqRuntimeError(`jq: cannot parse ${JSON.stringify(input)} as a number`);
  }
  return parsed;
}

function uniqueValues(input: JsonValue, budget: JqEvaluationBudget): JsonValue[] {
  const sorted = [...requireArray(input, "unique")].sort((a, b) => compareJson(a, b, budget));
  return sorted.filter((item, index) => {
    const previous = sorted[index - 1];
    return previous === undefined || !equalJson(item, previous, budget);
  });
}

function extremeValue(
  input: JsonValue,
  name: "min" | "max",
  budget: JqEvaluationBudget,
): JsonValue {
  const items = requireArray(input, name);
  if (items.length === 0) return null;
  return items.reduce((best, item) => {
    const order = compareJson(item, best, budget);
    return (name === "min" ? order < 0 : order > 0) ? item : best;
  });
}

function toEntries(input: JsonValue): JsonValue[] {
  return [...requireObject(input, "to_entries")].map(
    ([key, value]) =>
      new Map<string, JsonValue>([
        ["key", key],
        ["value", value],
      ]),
  );
}

function fromEntries(input: JsonValue): JsonObject {
  const built: JsonObject = new Map();
  for (const item of requireArray(input, "from_entries")) {
    const entry = requireObject(item, "from_entries");
    const key = entry.get("key") ?? entry.get("k") ?? entry.get("name") ?? null;
    const value = entry.get("value") ?? entry.get("v") ?? null;
    built.set(key === null ? "null" : scalarText(key, "from_entries"), value);
  }
  return built;
}

export function clampIndex(value: JsonValue, fallback: number, length: number): number {
  if (value === null) return fallback;
  if (!isJsonNumber(value)) throw new JqRuntimeError("jq: slice bounds must be numbers");
  const position = Math.trunc(numberOf(value));
  const resolved = position < 0 ? length + position : position;
  return Math.min(Math.max(resolved, 0), length);
}

export function requireNumber(value: JsonValue, what: string): number {
  if (!isJsonNumber(value)) throw new JqRuntimeError(`jq: ${jsonKind(value)} cannot be ${what}`);
  return numberOf(value);
}

export function requireArray(value: JsonValue, what: string): JsonValue[] {
  if (!Array.isArray(value))
    throw new JqRuntimeError(`jq: ${what} needs an array, got ${jsonKind(value)}`);
  return value;
}

function requireObject(value: JsonValue, what: string): JsonObject {
  if (!(value instanceof Map)) {
    throw new JqRuntimeError(`jq: ${what} needs an object, got ${jsonKind(value)}`);
  }
  return value;
}

export function scalarText(value: JsonValue, what: string): string {
  if (typeof value === "string") return value;
  if (isJsonNumber(value) || typeof value === "boolean" || value === null) return renderJson(value);
  throw new JqRuntimeError(`jq: ${what} cannot use ${jsonKind(value)} here`);
}

function lengthOf(value: JsonValue): JsonValue {
  if (value === null) return 0;
  if (typeof value === "boolean") throw new JqRuntimeError("jq: boolean has no length");
  if (isJsonNumber(value)) return Math.abs(numberOf(value));
  if (typeof value === "string") return codePointLength(value);
  return Array.isArray(value) ? value.length : value.size;
}

function keysOf(value: JsonValue): JsonValue[] {
  if (value instanceof Map) return [...value.keys()];
  if (Array.isArray(value)) return value.map((_item, index) => index);
  throw new JqRuntimeError(`jq: ${jsonKind(value)} has no keys`);
}

export function hasMember(value: JsonValue, key: JsonValue): boolean {
  if (value instanceof Map) {
    if (typeof key !== "string") throw new JqRuntimeError("jq: has needs a string key");
    return value.has(key);
  }
  if (Array.isArray(value)) {
    if (!isJsonNumber(key)) throw new JqRuntimeError("jq: has needs a number index");
    const index = numberOf(key);
    return index >= 0 && index < value.length;
  }
  throw new JqRuntimeError(`jq: cannot check a key on ${jsonKind(value)}`);
}

export function* splitJsonString(text: string, separator: string): Generator<string> {
  if (separator === "") {
    yield* text;
    return;
  }
  let offset = 0;
  for (;;) {
    const next = text.indexOf(separator, offset);
    if (next < 0) {
      yield text.slice(offset);
      return;
    }
    yield text.slice(offset, next);
    offset = next + separator.length;
  }
}

export function flatten(
  items: JsonValue[],
  depth: number,
  budget: JqEvaluationBudget,
): JsonValue[] {
  return budget.collect(flattenValues(items, depth, budget));
}
function* flattenValues(
  items: JsonValue[],
  depth: number,
  budget: JqEvaluationBudget,
): Generator<JsonValue> {
  budget.enter();
  try {
    for (const item of items) {
      budget.step();
      if (Array.isArray(item) && depth > 0) yield* flattenValues(item, depth - 1, budget);
      else yield item;
    }
  } finally {
    budget.leave();
  }
}

export function applyBinary(
  operator: BinaryOperator,
  left: JsonValue,
  right: JsonValue,
  budget: JqEvaluationBudget,
): JsonValue {
  budget.step();
  switch (operator) {
    case "==":
      return equalJson(left, right, budget);
    case "!=":
      return !equalJson(left, right, budget);
    case "<":
      return compareJson(left, right, budget) < 0;
    case "<=":
      return compareJson(left, right, budget) <= 0;
    case ">":
      return compareJson(left, right, budget) > 0;
    case ">=":
      return compareJson(left, right, budget) >= 0;
    case "+":
      return add(left, right, budget);
    case "-":
      return subtract(left, right, budget);
    case "*":
      return multiply(left, right, budget);
    case "/":
      return divide(left, right, budget);
    default:
      return modulo(left, right);
  }
}

function add(left: JsonValue, right: JsonValue, budget: JqEvaluationBudget): JsonValue {
  if (left === null) return right;
  if (right === null) return left;
  if (isJsonNumber(left) && isJsonNumber(right)) return numberOf(left) + numberOf(right);
  if (typeof left === "string" && typeof right === "string") {
    budget.reserve((left.length + right.length) * 2);
    return left + right;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    budget.reserve((left.length + right.length) * 8, left.length + right.length);
    return [...left, ...right];
  }
  if (left instanceof Map && right instanceof Map) {
    budget.reserve((left.size + right.size) * 32, left.size + right.size);
    const merged = new Map(left);
    for (const [key, value] of right) merged.set(key, value);
    return merged;
  }
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be added`);
}

function subtract(left: JsonValue, right: JsonValue, budget: JqEvaluationBudget): JsonValue {
  if (isJsonNumber(left) && isJsonNumber(right)) return numberOf(left) - numberOf(right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.filter((item) => !right.some((excluded) => equalJson(item, excluded, budget)));
  }
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be subtracted`);
}

function multiply(left: JsonValue, right: JsonValue, budget: JqEvaluationBudget): JsonValue {
  if (isJsonNumber(left) && isJsonNumber(right)) return numberOf(left) * numberOf(right);
  if (left instanceof Map && right instanceof Map) return deepMerge(left, right, budget);
  const [text, count] =
    typeof left === "string" && isJsonNumber(right)
      ? [left, numberOf(right)]
      : typeof right === "string" && isJsonNumber(left)
        ? [right, numberOf(left)]
        : [undefined, 0];
  if (text !== undefined) {
    budget.reserve(text.length * Math.max(0, Math.trunc(count)) * 2);
    return count <= 0 ? null : text.repeat(Math.trunc(count));
  }
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be multiplied`);
}

function deepMerge(left: JsonObject, right: JsonObject, budget: JqEvaluationBudget): JsonObject {
  budget.reserve((left.size + right.size) * 32, left.size + right.size);
  const merged = new Map(left);
  for (const [key, value] of right) {
    const existing = merged.get(key);
    merged.set(
      key,
      existing instanceof Map && value instanceof Map ? deepMerge(existing, value, budget) : value,
    );
  }
  return merged;
}

function divide(left: JsonValue, right: JsonValue, budget: JqEvaluationBudget): JsonValue {
  if (isJsonNumber(left) && isJsonNumber(right)) {
    const divisor = numberOf(right);
    if (divisor === 0) throw new JqRuntimeError("jq: cannot divide by zero");
    return numberOf(left) / divisor;
  }
  if (typeof left === "string" && typeof right === "string") {
    return budget.collect(splitJsonString(left, right));
  }
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be divided`);
}

function modulo(left: JsonValue, right: JsonValue): JsonValue {
  const divisor = Math.trunc(requireNumber(right, "a divisor"));
  if (divisor === 0) throw new JqRuntimeError("jq: cannot divide by zero");
  return Math.trunc(requireNumber(left, "a dividend")) % divisor;
}
