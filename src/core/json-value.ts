import { VfsError } from "./errors.js";
import { compareUtf8 } from "./path.js";
import { utf8ByteLength } from "./unicode.js";

/**
 * A JSON value as `jq` sees one.
 *
 * Two things a JavaScript object cannot do force this shape. An object reorders
 * integer-like keys — `{"2":1,"1":2}` parses with `1` first — while `jq` prints
 * members in the order they arrived, so members live in a `Map`, which keeps
 * insertion order for every key. And `JSON.parse` discards how a number was
 * written, while `jq` reprints an untouched number exactly as it read it, so a
 * parsed number carries its own spelling.
 */
export type JsonValue = null | boolean | string | number | JsonNumber | JsonValue[] | JsonObject;

export type JsonObject = Map<string, JsonValue>;

/**
 * A number that remembers how it was written.
 *
 * Only the parser makes one. Anything computed is a plain number, which is what
 * `jq` does too: arithmetic drops the original spelling because the result was
 * never spelled.
 */
export class JsonNumber {
  constructor(
    readonly value: number,
    readonly literal: string,
  ) {}
}

export function isJsonNumber(value: JsonValue): value is number | JsonNumber {
  return typeof value === "number" || value instanceof JsonNumber;
}

/** The double behind a number, however it was spelled. */
export function numberOf(value: number | JsonNumber): number {
  return value instanceof JsonNumber ? value.value : value;
}

export type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";

export function jsonKind(value: JsonValue): JsonKind {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (isJsonNumber(value)) return "number";
  if (typeof value === "string") return "string";
  return Array.isArray(value) ? "array" : "object";
}

/** `jq` treats only `false` and `null` as false. Zero and "" are true. */
export function isTruthy(value: JsonValue): boolean {
  return value !== null && value !== false;
}

function invalidJsonValue(): never {
  throw new TypeError("invalid JsonValue");
}

const JSON_KIND_ORDER: Readonly<Record<JsonKind, number>> = {
  null: 0,
  boolean: 1,
  number: 2,
  string: 3,
  array: 4,
  object: 5,
};

function compareArrays(left: readonly JsonValue[], right: readonly JsonValue[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return invalidJsonValue();
    const order = compareJson(a, b);
    if (order !== 0) return order;
  }
  return Math.sign(left.length - right.length);
}

function compareObjects(left: JsonObject, right: JsonObject): number {
  const leftKeys = [...left.keys()].sort(compareStrings);
  const rightKeys = [...right.keys()].sort(compareStrings);
  const keyOrder = compareArrays(leftKeys, rightKeys);
  if (keyOrder !== 0) return keyOrder;
  for (const key of leftKeys) {
    const a = left.get(key);
    const b = right.get(key);
    if (a === undefined || b === undefined) return invalidJsonValue();
    const order = compareJson(a, b);
    if (order !== 0) return order;
  }
  return 0;
}

function compareNumbers(left: number | JsonNumber, right: number | JsonNumber): number {
  const a = numberOf(left);
  const b = numberOf(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * `jq`'s total order: null < false < true < numbers < strings < arrays <
 * objects.
 *
 * Arrays compare element by element. Objects compare their sorted key lists
 * first and then the values in that order, which is why two objects that differ
 * only in member order compare equal.
 */
export function compareJson(left: JsonValue, right: JsonValue): number {
  const leftKind = jsonKind(left);
  const rightKind = jsonKind(right);
  if (leftKind !== rightKind)
    return Math.sign(JSON_KIND_ORDER[leftKind] - JSON_KIND_ORDER[rightKind]);
  if (left === null && right === null) return 0;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (isJsonNumber(left) && isJsonNumber(right)) return compareNumbers(left, right);
  if (typeof left === "string" && typeof right === "string") return compareStrings(left, right);
  if (Array.isArray(left) && Array.isArray(right)) return compareArrays(left, right);
  if (left instanceof Map && right instanceof Map) return compareObjects(left, right);
  return invalidJsonValue();
}

function compareStrings(left: string, right: string): number {
  return compareUtf8(left, right);
}

export function equalJson(left: JsonValue, right: JsonValue): boolean {
  return compareJson(left, right) === 0;
}

/** Reads every value in a stream of concatenated JSON texts. */
export function parseJsonStream(text: string, command: string): JsonValue[] {
  const reader = new JsonReader(text, command);
  const values: JsonValue[] = [];
  for (;;) {
    reader.skipSpace();
    if (reader.done()) return values;
    values.push(reader.value());
  }
}

export function parseJsonText(text: string, command: string): JsonValue {
  const values = parseJsonStream(text, command);
  const only = values[0];
  if (values.length !== 1 || only === undefined) {
    throw new VfsError("EINVAL", `${command}: expected one JSON value`);
  }
  return only;
}

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

class JsonReader {
  private offset = 0;

  constructor(
    private readonly text: string,
    private readonly command: string,
  ) {}

  done(): boolean {
    return this.offset >= this.text.length;
  }

  skipSpace(): void {
    while (this.offset < this.text.length) {
      const character = this.text[this.offset] ?? "";
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r")
        break;
      this.offset += 1;
    }
  }

  private fail(message: string): never {
    const byteOffset = utf8ByteLength(this.text.slice(0, this.offset));
    throw new VfsError("EINVAL", `${this.command}: ${message} at byte ${byteOffset}`);
  }

  private expect(character: string): void {
    if (this.text[this.offset] !== character) this.fail(`expected ${character}`);
    this.offset += 1;
  }

  value(): JsonValue {
    this.skipSpace();
    const character = this.text[this.offset];
    if (character === undefined) this.fail("unexpected end of input");
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (this.text.startsWith("true", this.offset)) {
      this.offset += 4;
      return true;
    }
    if (this.text.startsWith("false", this.offset)) {
      this.offset += 5;
      return false;
    }
    if (this.text.startsWith("null", this.offset)) {
      this.offset += 4;
      return null;
    }
    return this.number();
  }

  private number(): JsonNumber {
    const matched = NUMBER.exec(this.text.slice(this.offset));
    if (matched === null) this.fail("invalid JSON");
    const literal = matched[0];
    this.offset += literal.length;
    const value = Number(literal);
    // A plain spelling is kept, which is what makes `1.0` and `2.50` and an
    // integer past a double's reach print back as they arrived. An exponent is
    // not kept: `jq` re-spells those through its own formatter, and reproducing
    // that is a declared divergence rather than an approximation of it.
    return new JsonNumber(value, /[eE]/u.test(literal) ? renderJsonNumber(value) : literal);
  }

  private escape(): string {
    const marker = this.text[this.offset + 1];
    if (marker === undefined) this.fail("unterminated escape");
    if (marker !== "u") {
      const replacement = ESCAPES[marker];
      if (replacement === undefined) this.fail("invalid escape");
      this.offset += 2;
      return replacement;
    }
    const code = this.text.slice(this.offset + 2, this.offset + 6);
    if (!/^[0-9a-fA-F]{4}$/u.test(code)) this.fail("invalid unicode escape");
    this.offset += 6;
    return String.fromCharCode(Number.parseInt(code, 16));
  }

  private string(): string {
    this.expect('"');
    let value = "";
    for (;;) {
      const character = this.text[this.offset];
      if (character === undefined) this.fail("unterminated string");
      if (character === '"') {
        this.offset += 1;
        return value;
      }
      if (character !== "\\") {
        if (character.charCodeAt(0) < 0x20) this.fail("unescaped control character");
        value += character;
        this.offset += 1;
        continue;
      }
      value += this.escape();
    }
  }

  private array(): JsonValue[] {
    this.expect("[");
    const items: JsonValue[] = [];
    this.skipSpace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return items;
    }
    for (;;) {
      items.push(this.value());
      this.skipSpace();
      if (!this.nextItem("]")) return items;
    }
  }

  private object(): JsonObject {
    this.expect("{");
    const entries: JsonObject = new Map();
    this.skipSpace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return entries;
    }
    for (;;) {
      this.skipSpace();
      const key = this.string();
      this.skipSpace();
      this.expect(":");
      // A repeated key keeps the first position and the last value, which is
      // what `jq` does — and what a plain object would also do, by accident.
      const value = this.value();
      entries.set(key, value);
      this.skipSpace();
      if (!this.nextItem("}")) return entries;
    }
  }

  private nextItem(close: "]" | "}"): boolean {
    const character = this.text[this.offset];
    if (character === ",") {
      this.offset += 1;
      return true;
    }
    if (character !== close) this.fail(`expected , or ${close}`);
    this.offset += 1;
    return false;
  }
}

export interface RenderOptions {
  /** Indent width, or `"\t"`. Absent renders on one line. */
  readonly indent?: number | "\t" | undefined;
  readonly sortKeys?: boolean | undefined;
}

/** Whether a string holds anything the JSON writer has to escape. */
function needsEscaping(value: string): boolean {
  for (const character of value) {
    if (character === '"' || character === "\\") return true;
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function escapedJsonCharacter(character: string): string {
  if (character === '"') return '\\"';
  if (character === "\\") return "\\\\";
  if (character === "\n") return "\\n";
  if (character === "\t") return "\\t";
  if (character === "\r") return "\\r";
  if (character === "\b") return "\\b";
  if (character === "\f") return "\\f";
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : character;
}

function renderJsonString(value: string): string {
  if (!needsEscaping(value)) return `"${value}"`;
  let out = '"';
  for (const character of value) out += escapedJsonCharacter(character);
  return `${out}"`;
}

/** How `jq` writes a computed number. */
function renderJsonNumber(value: number): string {
  if (Number.isNaN(value)) return "null";
  if (value === Number.POSITIVE_INFINITY) return "1.7976931348623157e+308";
  if (value === Number.NEGATIVE_INFINITY) return "-1.7976931348623157e+308";
  return Object.is(value, -0) ? "-0" : String(value);
}

export function renderJson(value: JsonValue, options: RenderOptions = {}): string {
  const indent =
    options.indent === undefined
      ? undefined
      : options.indent === "\t"
        ? "\t"
        : " ".repeat(options.indent);
  return write(value, indent, "", options.sortKeys === true);
}

function writeArray(
  value: readonly JsonValue[],
  indent: string | undefined,
  current: string,
  sortKeys: boolean,
): string {
  if (value.length === 0) return "[]";
  const inner = indent === undefined ? "" : current + indent;
  const items: string[] = [];
  for (const item of value) {
    items.push(item === undefined ? invalidJsonValue() : write(item, indent, inner, sortKeys));
  }
  const open = indent === undefined ? "" : `\n${inner}`;
  const separator = indent === undefined ? "," : `,\n${inner}`;
  const close = indent === undefined ? "" : `\n${current}`;
  return `[${open}${items.join(separator)}${close}]`;
}

function writeObject(
  value: JsonObject,
  indent: string | undefined,
  current: string,
  sortKeys: boolean,
): string {
  const keys = [...value.keys()];
  if (keys.length === 0) return "{}";
  if (sortKeys) keys.sort(compareStrings);
  const inner = indent === undefined ? "" : current + indent;
  const space = indent === undefined ? "" : " ";
  const members = keys.map((key) => {
    const member = value.get(key);
    if (member === undefined) return invalidJsonValue();
    return `${renderJsonString(key)}:${space}${write(member, indent, inner, sortKeys)}`;
  });
  const open = indent === undefined ? "" : `\n${inner}`;
  const separator = indent === undefined ? "," : `,\n${inner}`;
  const close = indent === undefined ? "" : `\n${current}`;
  return `{${open}${members.join(separator)}${close}}`;
}

function write(
  value: JsonValue,
  indent: string | undefined,
  current: string,
  sortKeys: boolean,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof JsonNumber) return value.literal;
  if (typeof value === "number") return renderJsonNumber(value);
  if (typeof value === "string") return renderJsonString(value);
  return Array.isArray(value)
    ? writeArray(value, indent, current, sortKeys)
    : writeObject(value, indent, current, sortKeys);
}
