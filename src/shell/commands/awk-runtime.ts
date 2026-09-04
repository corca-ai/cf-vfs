import { VfsError } from "../../core/errors.js";
import { compareUtf8 } from "../../core/path.js";
import { compilePosixRegex, type PosixRegex } from "../../core/posix-regex.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { ShellCommandContext } from "../types.js";
import type { AwkRule } from "./awk-ast.js";
import { retainAwkVariable } from "./awk-strings.js";

export interface AwkString {
  readonly kind: "string";
  readonly value: string;
  /** Input-derived numeric strings carry AWK's strnum attribute. */
  readonly numeric: boolean;
}

export type AwkValue = number | AwkString;

export interface AwkRuntimeState {
  readonly context: ShellCommandContext;
  readonly variables: Map<string, AwkValue>;
  readonly arrays: Map<string, Map<string, AwkValue>>;
  readonly regexCache: Map<string, PosixRegex>;
  readonly activeRanges: Set<AwkRule>;
  scalarSizes: Map<string, number>;
  scalarBytes: number;
  scalarRelease: () => void;
  arrayEntries: number;
  arrayBytes: number;
  arrayRelease: () => void;
  record: string;
  fields: AwkString[];
  fieldsValid: boolean;
  fieldSeparator: string;
  nr: number;
  fnr: number;
  filename: string;
  exitStatus: number;
}

export const stringValue = (value: string, numeric = false): AwkString => ({
  kind: "string",
  value,
  numeric,
});

export const inputValue = (value: string): AwkString =>
  stringValue(
    value,
    value === "" || /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/u.test(value),
  );

function numericPrefix(value: string): number {
  const prefix = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(value)?.[0];
  return prefix === undefined ? 0 : Number(prefix);
}

export function asNumber(value: AwkValue): number {
  return typeof value === "number" ? value : numericPrefix(value.value);
}

export function normalizeExponent(value: string): string {
  return value.replace(/e([+-])(\d)$/u, "e$10$2");
}

export function generalNumber(value: number, precision: number): string {
  return normalizeExponent(
    value.toPrecision(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))(?=e|$)/u, "$1"),
  );
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : value > 0 ? "inf" : "nan";
  if (Object.is(value, -0)) return "0";
  if (Number.isSafeInteger(value)) return String(value);
  return generalNumber(value, 6);
}

export function asString(value: AwkValue): string {
  return typeof value === "number" ? numberText(value) : value.value;
}

export function truth(value: AwkValue): boolean {
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  return value.numeric ? numericPrefix(value.value) !== 0 : value.value.length > 0;
}

function numericComparable(value: AwkValue): boolean {
  return typeof value === "number" || value.numeric;
}

export function compareAwkValues(left: AwkValue, right: AwkValue): number {
  if (numericComparable(left) && numericComparable(right)) return asNumber(left) - asNumber(right);
  return compareUtf8(asString(left), asString(right));
}

export function getVariable(state: AwkRuntimeState, name: string): AwkValue {
  if (name === "NR") return state.nr;
  if (name === "FNR") return state.fnr;
  if (name === "NF") {
    ensureFields(state);
    return state.fields.length;
  }
  if (name === "FILENAME") return stringValue(state.filename);
  if (state.arrays.has(name)) throw new VfsError("EINVAL", `awk: ${name} is an array`);
  return state.variables.get(name) ?? inputValue("");
}

export function setVariable(state: AwkRuntimeState, name: string, value: AwkValue): void {
  if (state.arrays.has(name)) throw new VfsError("EINVAL", `awk: ${name} is an array`);
  if (name === "NF" || name === "FILENAME") {
    throw new VfsError("EINVAL", `awk: cannot assign to ${name}`);
  }
  if (name === "NR" || name === "FNR") {
    state[name.toLowerCase() as "nr" | "fnr"] = Math.trunc(asNumber(value));
    return;
  }
  const text = asString(value);
  if (name === "RS" && text !== "\n") {
    throw new VfsError("ENOTSUP", "awk: record separators other than newline are unsupported");
  }
  if ((name === "OFMT" || name === "CONVFMT") && text !== "%.6g") {
    throw new VfsError("ENOTSUP", `awk: changing ${name} is unsupported`);
  }
  if (name === "FS") validateFieldSeparator(state, text);
  retainAwkVariable(state, name, value);
  state.variables.set(name, value);
}

export function getArray(state: AwkRuntimeState, name: string): Map<string, AwkValue> {
  if (state.variables.has(name)) throw new VfsError("EINVAL", `awk: ${name} is not an array`);
  let array = state.arrays.get(name);
  if (array === undefined) {
    array = new Map();
    state.arrays.set(name, array);
  }
  return array;
}

function arrayEntryBytes(key: string, value: AwkValue): number {
  return utf8ByteLength(key) + utf8ByteLength(asString(value));
}

function resizeArrayBuffer(state: AwkRuntimeState, bytes: number): void {
  state.arrayRelease();
  state.arrayRelease = () => undefined;
  state.arrayBytes = bytes;
  state.arrayRelease = state.context.budget.buffered(bytes);
}

export function putArray(state: AwkRuntimeState, name: string, key: string, value: AwkValue): void {
  const array = getArray(state, name);
  const previous = array.get(key);
  if (!array.has(key)) {
    if (state.arrayEntries >= state.context.budget.limits.maxBufferedRecords) {
      throw new VfsError("E2BIG", "awk: array entry limit exceeded");
    }
    state.arrayEntries += 1;
  }
  const previousBytes = previous === undefined ? 0 : arrayEntryBytes(key, previous);
  resizeArrayBuffer(state, state.arrayBytes + arrayEntryBytes(key, value) - previousBytes);
  array.set(key, value);
}

export function clearArray(state: AwkRuntimeState, name: string): Map<string, AwkValue> {
  const array = getArray(state, name);
  let releasedBytes = 0;
  for (const [key, value] of array) releasedBytes += arrayEntryBytes(key, value);
  resizeArrayBuffer(state, state.arrayBytes - releasedBytes);
  state.arrayEntries -= array.size;
  array.clear();
  return array;
}

export function removeArrayEntry(
  state: AwkRuntimeState,
  array: Map<string, AwkValue>,
  key: string,
): void {
  const value = array.get(key);
  if (value === undefined) return;
  resizeArrayBuffer(state, state.arrayBytes - arrayEntryBytes(key, value));
  array.delete(key);
  state.arrayEntries -= 1;
}

export function fieldIndex(value: AwkValue): number {
  const index = Math.trunc(asNumber(value));
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new VfsError("EINVAL", "awk: invalid field index");
  }
  return index;
}

export function getField(state: AwkRuntimeState, index: number): AwkValue {
  if (index === 0) return inputValue(state.record);
  ensureFields(state);
  return state.fields[index - 1] ?? inputValue("");
}

function rebuiltRecord(state: AwkRuntimeState, separator: string): string {
  let characters = Math.max(0, state.fields.length - 1) * separator.length;
  for (const field of state.fields) {
    characters += field.value.length;
    if (characters > state.context.budget.limits.maxExpansionChars) {
      throw new VfsError("E2BIG", "awk: rebuilt record exceeds the expansion limit");
    }
  }
  return state.fields.map((field) => field.value).join(separator);
}

export function setField(state: AwkRuntimeState, index: number, value: AwkValue): void {
  if (index === 0) {
    state.record = asString(value);
    state.fieldSeparator = asString(getVariable(state, "FS"));
    state.fieldsValid = false;
    return;
  }
  if (index > state.context.budget.limits.maxBufferedRecords) {
    throw new VfsError("E2BIG", "awk: field limit exceeded");
  }
  ensureFields(state);
  while (state.fields.length < index) state.fields.push(inputValue(""));
  state.fields[index - 1] = stringValue(asString(value), numericComparable(value));
  state.record = rebuiltRecord(state, asString(getVariable(state, "OFS")));
}

export function compiledRegex(state: AwkRuntimeState, source: string): PosixRegex {
  const cached = state.regexCache.get(source);
  if (cached !== undefined) return cached;
  const pattern = compilePosixRegex(source, "extended", "awk");
  state.regexCache.set(source, pattern);
  return pattern;
}

function separatorRegex(state: AwkRuntimeState, separator: string): PosixRegex {
  const pattern = compiledRegex(state, separator);
  if (pattern.test("")) throw new VfsError("EINVAL", "awk: an empty-matching FS is unsupported");
  return pattern;
}

export function validateFieldSeparator(state: AwkRuntimeState, separator: string): void {
  if (separator === "") throw new VfsError("EINVAL", "awk: empty FS is unsupported");
  if (separator !== " " && [...separator].length > 1) separatorRegex(state, separator);
}

function checkFieldCount(state: AwkRuntimeState, count: number): void {
  if (count > state.context.budget.limits.maxBufferedRecords) {
    throw new VfsError("E2BIG", "awk: field limit exceeded");
  }
}

export function splitByRegex(
  state: AwkRuntimeState,
  text: string,
  pattern: PosixRegex,
): AwkString[] {
  const fields: AwkString[] = [];
  let offset = 0;
  for (;;) {
    const match = pattern.exec(text, offset);
    if (match === undefined) break;
    checkFieldCount(state, fields.length + 1);
    fields.push(inputValue(text.slice(offset, match.index)));
    offset = match.end;
  }
  checkFieldCount(state, fields.length + 1);
  fields.push(inputValue(text.slice(offset)));
  return fields;
}

function countWhitespaceFields(state: AwkRuntimeState, text: string): void {
  if (text.length < state.context.budget.limits.maxBufferedRecords) return;
  let count = 0;
  for (const _match of text.matchAll(/[^ \t\n]+/gu)) checkFieldCount(state, ++count);
}

function countLiteralFields(state: AwkRuntimeState, text: string, separator: string): void {
  if (text.length + 1 <= state.context.budget.limits.maxBufferedRecords) return;
  let count = 1;
  let offset = 0;
  for (;;) {
    const found = text.indexOf(separator, offset);
    if (found < 0) return;
    checkFieldCount(state, ++count);
    offset = found + separator.length;
  }
}

export function splitText(state: AwkRuntimeState, text: string, separator: string): AwkString[] {
  if (text === "") return [];
  if (separator === " ") {
    const trimmed = text.replace(/^[ \t\n]+|[ \t\n]+$/gu, "");
    countWhitespaceFields(state, trimmed);
    return trimmed === "" ? [] : trimmed.split(/[ \t\n]+/u).map(inputValue);
  }
  if ([...separator].length === 1) {
    countLiteralFields(state, text, separator);
    return text.split(separator).map(inputValue);
  }
  return splitByRegex(state, text, separatorRegex(state, separator));
}

function splitRecord(state: AwkRuntimeState): void {
  state.fields = splitText(state, state.record, state.fieldSeparator);
  state.fieldsValid = true;
}

function ensureFields(state: AwkRuntimeState): void {
  if (!state.fieldsValid) splitRecord(state);
}
