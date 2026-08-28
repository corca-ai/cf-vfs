import { VfsError } from "./errors.js";
import {
  compareJson,
  equalJson,
  isJsonNumber,
  isTruthy,
  type JsonObject,
  type JsonValue,
  jsonKind,
  numberOf,
  parseJsonText,
  renderJson,
} from "./json-value.js";

/**
 * A declared subset of the `jq` filter language.
 *
 * Paths, pipes, the comma, alternatives, comparison, arithmetic, array and
 * object construction, and a named list of builtins. Everything outside that is
 * refused where it is written rather than approximated, which is the same
 * stance the `sed` profile and the regular-expression subset take: a filter
 * this accepts means here what it means in `jq`, and one it does not accept is
 * a usage error before any input is read.
 *
 * Notably absent, and refused: `def`, `reduce`, `foreach`, `try`/`catch`,
 * `label`, `as` bindings, recursive descent `..`, string interpolation, format
 * strings such as `@base64`, and the regular-expression builtins. The last is
 * deliberate rather than pending — `jq` matches with Oniguruma and this
 * repository has a POSIX engine, so `test("a+")` would mean two different
 * things under one name.
 */

const MAX_NODES = 2048;
const MAX_OUTPUTS = 100_000;

type Node =
  | { readonly kind: "identity" }
  | { readonly kind: "field"; readonly name: string; readonly optional: boolean; readonly of: Node }
  | { readonly kind: "index"; readonly of: Node; readonly index: Node; readonly optional: boolean }
  | {
      readonly kind: "slice";
      readonly of: Node;
      readonly from: Node | undefined;
      readonly to: Node | undefined;
      readonly optional: boolean;
    }
  | { readonly kind: "iterate"; readonly of: Node; readonly optional: boolean }
  | { readonly kind: "literal"; readonly value: JsonValue }
  | { readonly kind: "pipe"; readonly left: Node; readonly right: Node }
  | { readonly kind: "comma"; readonly left: Node; readonly right: Node }
  | { readonly kind: "alternative"; readonly left: Node; readonly right: Node }
  | {
      readonly kind: "binary";
      readonly operator: BinaryOperator;
      readonly left: Node;
      readonly right: Node;
    }
  | { readonly kind: "negate"; readonly of: Node }
  | { readonly kind: "array"; readonly body: Node | undefined }
  | { readonly kind: "object"; readonly entries: readonly ObjectEntry[] }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly Node[] }
  | { readonly kind: "variable"; readonly name: string };

interface ObjectEntry {
  readonly key: Node;
  readonly value: Node;
}

type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";

export interface JqOptions {
  /** Values bound to `$name`, from `--arg` and `--argjson`. */
  readonly variables?: ReadonlyMap<string, JsonValue> | undefined;
}

/** Raised for a filter this profile does not accept. Status 3, as in `jq`. */
export class JqSyntaxError extends VfsError {
  constructor(message: string) {
    super("EINVAL", message);
  }
}

/** Raised while running a filter. Status 5, as in `jq`. */
export class JqRuntimeError extends VfsError {
  constructor(message: string) {
    super("EINVAL", message);
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { readonly type: "punct"; readonly value: string }
  | { readonly type: "ident"; readonly value: string }
  | { readonly type: "variable"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "end" };

const PUNCTUATION = [
  "?//",
  "//",
  "==",
  "!=",
  "<=",
  ">=",
  "|",
  ",",
  ".",
  "[",
  "]",
  "{",
  "}",
  "(",
  ")",
  ":",
  ";",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "?",
  "$",
];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/u;
const NUMBER = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset] ?? "";
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      offset += 1;
      continue;
    }
    if (character === "#") {
      while (offset < source.length && source[offset] !== "\n") offset += 1;
      continue;
    }
    if (character === '"') {
      const { value, next } = readString(source, offset);
      tokens.push({ type: "string", value });
      offset = next;
      continue;
    }
    if (character === "$") {
      const name = IDENT.exec(source.slice(offset + 1));
      if (name === null) throw new JqSyntaxError("jq: $ must name a variable");
      tokens.push({ type: "variable", value: name[0] });
      offset += 1 + name[0].length;
      continue;
    }
    const identifier = IDENT.exec(source.slice(offset));
    if (identifier !== null) {
      tokens.push({ type: "ident", value: identifier[0] });
      offset += identifier[0].length;
      continue;
    }
    // A number is only a number where one can start; `.5` after a value is a
    // field access, and the parser decides which by position.
    if (/[0-9]/u.test(character)) {
      const number = NUMBER.exec(source.slice(offset));
      if (number !== null) {
        tokens.push({ type: "number", value: Number(number[0]) });
        offset += number[0].length;
        continue;
      }
    }
    const punct = PUNCTUATION.find((candidate) => source.startsWith(candidate, offset));
    if (punct === undefined) {
      throw new JqSyntaxError(`jq: unexpected character ${JSON.stringify(character)}`);
    }
    tokens.push({ type: "punct", value: punct });
    offset += punct.length;
  }
  tokens.push({ type: "end" });
  return tokens;
}

function readString(source: string, start: number): { value: string; next: number } {
  let offset = start + 1;
  let value = "";
  while (offset < source.length) {
    const character = source[offset] ?? "";
    if (character === '"') return { value, next: offset + 1 };
    if (character === "\\") {
      const marker = source[offset + 1];
      if (marker === "(") {
        throw new JqSyntaxError("jq: string interpolation is not supported by this profile");
      }
      if (marker === "u") {
        const code = source.slice(offset + 2, offset + 6);
        if (!/^[0-9a-fA-F]{4}$/u.test(code)) throw new JqSyntaxError("jq: invalid unicode escape");
        value += String.fromCharCode(Number.parseInt(code, 16));
        offset += 6;
        continue;
      }
      const replacements: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
      };
      const replacement = marker === undefined ? undefined : replacements[marker];
      if (replacement === undefined) throw new JqSyntaxError("jq: invalid escape in string");
      value += replacement;
      offset += 2;
      continue;
    }
    value += character;
    offset += 1;
  }
  throw new JqSyntaxError("jq: unterminated string");
}

// --------------------------------------------------------------- parser

/** Reserved words this profile refuses rather than silently treating as calls. */
const REFUSED = new Map<string, string>([
  ["def", "function definitions"],
  ["reduce", "reduce"],
  ["foreach", "foreach"],
  ["try", "try/catch"],
  ["catch", "try/catch"],
  ["label", "label/break"],
  ["as", "variable bindings"],
  ["import", "modules"],
  ["include", "modules"],
]);

const BUILTIN_NAMES = new Set([
  "add",
  "all",
  "any",
  "empty",
  "first",
  "flatten",
  "from_entries",
  "has",
  "join",
  "keys",
  "keys_unsorted",
  "last",
  "length",
  "map",
  "max",
  "min",
  "not",
  "range",
  "reverse",
  "select",
  "sort",
  "sort_by",
  "split",
  "to_entries",
  "tonumber",
  "tostring",
  "type",
  "unique",
  "values",
]);

class Parser {
  private offset = 0;
  private nodes = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.offset] ?? { type: "end" };
  }

  private take(): Token {
    const token = this.peek();
    this.offset += 1;
    return token;
  }

  private at(value: string): boolean {
    const token = this.peek();
    return token.type === "punct" && token.value === value;
  }

  private eat(value: string): boolean {
    if (!this.at(value)) return false;
    this.offset += 1;
    return true;
  }

  private expect(value: string): void {
    if (!this.eat(value)) throw new JqSyntaxError(`jq: expected ${value}`);
  }

  private count(): void {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new JqSyntaxError("jq: filter is too large");
  }

  parse(): Node {
    const node = this.pipe();
    if (this.peek().type !== "end") throw new JqSyntaxError("jq: unexpected trailing input");
    return node;
  }

  private pipe(): Node {
    let left = this.comma();
    while (this.eat("|")) {
      this.count();
      left = { kind: "pipe", left, right: this.comma() };
    }
    return left;
  }

  private comma(): Node {
    let left = this.alternative();
    while (this.eat(",")) {
      this.count();
      left = { kind: "comma", left, right: this.alternative() };
    }
    return left;
  }

  private alternative(): Node {
    let left = this.or();
    while (this.eat("//")) {
      this.count();
      left = { kind: "alternative", left, right: this.or() };
    }
    return left;
  }

  private or(): Node {
    let left = this.and();
    for (;;) {
      const token = this.peek();
      if (token.type !== "ident" || token.value !== "or") return left;
      this.take();
      this.count();
      left = { kind: "binary", operator: "or", left, right: this.and() };
    }
  }

  private and(): Node {
    let left = this.comparison();
    for (;;) {
      const token = this.peek();
      if (token.type !== "ident" || token.value !== "and") return left;
      this.take();
      this.count();
      left = { kind: "binary", operator: "and", left, right: this.comparison() };
    }
  }

  private comparison(): Node {
    let left = this.additive();
    for (;;) {
      const operator = (["==", "!=", "<=", ">=", "<", ">"] as const).find((candidate) =>
        this.at(candidate),
      );
      if (operator === undefined) return left;
      this.take();
      this.count();
      left = { kind: "binary", operator, left, right: this.additive() };
    }
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (;;) {
      const operator = this.at("+") ? "+" : this.at("-") ? "-" : undefined;
      if (operator === undefined) return left;
      this.take();
      this.count();
      left = { kind: "binary", operator, left, right: this.multiplicative() };
    }
  }

  private multiplicative(): Node {
    let left = this.unary();
    for (;;) {
      const operator = this.at("*") ? "*" : this.at("/") ? "/" : this.at("%") ? "%" : undefined;
      if (operator === undefined) return left;
      this.take();
      this.count();
      left = { kind: "binary", operator, left, right: this.unary() };
    }
  }

  private unary(): Node {
    if (this.eat("-")) {
      this.count();
      return { kind: "negate", of: this.unary() };
    }
    return this.postfix(this.primary());
  }

  /** `.a`, `[0]`, `[]`, `[a:b]`, and `?`, applied left to right. */
  private postfix(start: Node): Node {
    let node = start;
    for (;;) {
      this.count();
      if (this.at(".")) {
        const next = this.tokens[this.offset + 1];
        if (next?.type === "ident") {
          this.take();
          this.take();
          node = { kind: "field", name: next.value, optional: false, of: node };
          continue;
        }
        if (next?.type === "punct" && next.value === "[") {
          this.take();
          continue;
        }
        return node;
      }
      if (this.at("[")) {
        this.take();
        node = this.bracket(node);
        continue;
      }
      if (this.eat("?")) {
        node = withOptional(node);
        continue;
      }
      return node;
    }
  }

  private bracket(of: Node): Node {
    if (this.eat("]")) return { kind: "iterate", of, optional: false };
    if (this.eat(":")) {
      const to = this.pipe();
      this.expect("]");
      return { kind: "slice", of, from: undefined, to, optional: false };
    }
    const first = this.pipe();
    if (this.eat(":")) {
      if (this.eat("]")) return { kind: "slice", of, from: first, to: undefined, optional: false };
      const to = this.pipe();
      this.expect("]");
      return { kind: "slice", of, from: first, to, optional: false };
    }
    this.expect("]");
    return { kind: "index", of, index: first, optional: false };
  }

  private primary(): Node {
    this.count();
    const token = this.peek();
    if (token.type === "punct" && token.value === ".") {
      this.take();
      const next = this.peek();
      if (next.type === "ident") {
        this.take();
        return { kind: "field", name: next.value, optional: false, of: { kind: "identity" } };
      }
      if (next.type === "string") {
        this.take();
        return {
          kind: "index",
          of: { kind: "identity" },
          index: { kind: "literal", value: next.value },
          optional: false,
        };
      }
      if (next.type === "punct" && next.value === ".") {
        throw new JqSyntaxError("jq: recursive descent .. is not supported by this profile");
      }
      return { kind: "identity" };
    }
    if (token.type === "number") {
      this.take();
      return { kind: "literal", value: token.value };
    }
    if (token.type === "string") {
      this.take();
      return { kind: "literal", value: token.value };
    }
    if (token.type === "variable") {
      this.take();
      return { kind: "variable", name: token.value };
    }
    if (token.type === "punct" && token.value === "(") {
      this.take();
      const inner = this.pipe();
      this.expect(")");
      return inner;
    }
    if (token.type === "punct" && token.value === "[") {
      this.take();
      if (this.eat("]")) return { kind: "array", body: undefined };
      const body = this.pipe();
      this.expect("]");
      return { kind: "array", body };
    }
    if (token.type === "punct" && token.value === "{") {
      this.take();
      return this.objectConstruction();
    }
    if (token.type === "ident") {
      const refused = REFUSED.get(token.value);
      if (refused !== undefined) {
        throw new JqSyntaxError(`jq: ${refused} is not supported by this profile`);
      }
      this.take();
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      const args: Node[] = [];
      if (this.eat("(")) {
        args.push(this.pipe());
        while (this.eat(";")) args.push(this.pipe());
        this.expect(")");
      }
      if (!BUILTIN_NAMES.has(token.value)) {
        throw new JqSyntaxError(`jq: ${token.value} is not a function in this profile`);
      }
      return { kind: "call", name: token.value, args };
    }
    throw new JqSyntaxError("jq: unexpected end of filter");
  }

  private objectConstruction(): Node {
    const entries: ObjectEntry[] = [];
    if (this.eat("}")) return { kind: "object", entries };
    for (;;) {
      const token = this.take();
      let key: Node;
      let value: Node | undefined;
      if (token.type === "ident") {
        key = { kind: "literal", value: token.value };
        // `{a}` is shorthand for `{a: .a}`, which is the common spelling.
        value = { kind: "field", name: token.value, optional: false, of: { kind: "identity" } };
      } else if (token.type === "string") {
        key = { kind: "literal", value: token.value };
        value = {
          kind: "index",
          of: { kind: "identity" },
          index: { kind: "literal", value: token.value },
          optional: false,
        };
      } else if (token.type === "variable") {
        key = { kind: "literal", value: token.value };
        value = { kind: "variable", name: token.value };
      } else if (token.type === "punct" && token.value === "(") {
        key = this.pipe();
        this.expect(")");
        value = undefined;
      } else {
        throw new JqSyntaxError("jq: expected an object key");
      }
      if (this.eat(":")) value = this.alternative();
      if (value === undefined) throw new JqSyntaxError("jq: expected a value for the object key");
      entries.push({ key, value });
      if (this.eat(",")) continue;
      this.expect("}");
      return { kind: "object", entries };
    }
  }
}

function withOptional(node: Node): Node {
  switch (node.kind) {
    case "field":
    case "index":
    case "slice":
    case "iterate":
      return { ...node, optional: true };
    default:
      throw new JqSyntaxError("jq: ? must follow a path expression");
  }
}

export function compileJq(source: string, options: JqOptions = {}): JqFilter {
  return new JqFilter(new Parser(tokenize(source)).parse(), options.variables ?? new Map());
}

// ------------------------------------------------------------ evaluation

export class JqFilter {
  constructor(
    private readonly node: Node,
    private readonly variables: ReadonlyMap<string, JsonValue>,
  ) {}

  /** Every value this filter produces for one input. */
  run(input: JsonValue): JsonValue[] {
    const out: JsonValue[] = [];
    for (const value of this.evaluate(this.node, input)) {
      out.push(value);
      if (out.length > MAX_OUTPUTS)
        throw new JqRuntimeError("jq: filter produced too many results");
    }
    return out;
  }

  private *evaluate(node: Node, input: JsonValue): Generator<JsonValue> {
    switch (node.kind) {
      case "identity":
        yield input;
        return;
      case "literal":
        yield node.value;
        return;
      case "variable": {
        const value = this.variables.get(node.name);
        if (value === undefined) throw new JqRuntimeError(`jq: $${node.name} is not defined`);
        yield value;
        return;
      }
      case "pipe":
        for (const left of this.evaluate(node.left, input)) yield* this.evaluate(node.right, left);
        return;
      case "comma":
        yield* this.evaluate(node.left, input);
        yield* this.evaluate(node.right, input);
        return;
      case "alternative": {
        let produced = false;
        try {
          for (const value of this.evaluate(node.left, input)) {
            if (!isTruthy(value)) continue;
            produced = true;
            yield value;
          }
        } catch (error) {
          if (!(error instanceof JqRuntimeError)) throw error;
        }
        if (!produced) yield* this.evaluate(node.right, input);
        return;
      }
      case "negate":
        for (const value of this.evaluate(node.of, input)) {
          yield -requireNumber(value, "negated");
        }
        return;
      case "field":
        for (const target of this.evaluate(node.of, input)) {
          const value = this.member(target, node.name, node.optional);
          if (value !== SKIP) yield value;
        }
        return;
      case "index":
        for (const target of this.evaluate(node.of, input)) {
          for (const index of this.evaluate(node.index, input)) {
            const value = this.at(target, index, node.optional);
            if (value !== SKIP) yield value;
          }
        }
        return;
      case "slice":
        for (const target of this.evaluate(node.of, input)) {
          const froms = node.from === undefined ? [null] : [...this.evaluate(node.from, input)];
          const tos = node.to === undefined ? [null] : [...this.evaluate(node.to, input)];
          for (const from of froms) {
            for (const to of tos) {
              const value = this.slice(target, from, to, node.optional);
              if (value !== SKIP) yield value;
            }
          }
        }
        return;
      case "iterate":
        for (const target of this.evaluate(node.of, input)) {
          if (Array.isArray(target)) {
            yield* target;
            continue;
          }
          if (target instanceof Map) {
            yield* target.values();
            continue;
          }
          if (node.optional) continue;
          throw new JqRuntimeError(`jq: cannot iterate over ${jsonKind(target)}`);
        }
        return;
      case "array": {
        if (node.body === undefined) {
          yield [];
          return;
        }
        yield [...this.evaluate(node.body, input)];
        return;
      }
      case "object":
        yield* this.buildObject(node.entries, 0, new Map(), input);
        return;
      case "binary":
        yield* this.binary(node, input);
        return;
      default:
        yield* this.call(node, input);
    }
  }

  private *binary(node: Extract<Node, { kind: "binary" }>, input: JsonValue): Generator<JsonValue> {
    if (node.operator === "and" || node.operator === "or") {
      for (const left of this.evaluate(node.left, input)) {
        const shortCircuit = node.operator === "and" ? !isTruthy(left) : isTruthy(left);
        if (shortCircuit) {
          yield node.operator === "or";
          continue;
        }
        for (const right of this.evaluate(node.right, input)) yield isTruthy(right);
      }
      return;
    }
    // `jq` evaluates the right side first, so `.[] * 2` pairs each left value
    // with each right one in that order.
    for (const right of this.evaluate(node.right, input)) {
      for (const left of this.evaluate(node.left, input)) {
        yield applyBinary(node.operator, left, right);
      }
    }
  }

  private *buildObject(
    entries: readonly ObjectEntry[],
    index: number,
    built: JsonObject,
    input: JsonValue,
  ): Generator<JsonValue> {
    const entry = entries[index];
    if (entry === undefined) {
      yield new Map(built);
      return;
    }
    for (const key of this.evaluate(entry.key, input)) {
      if (typeof key !== "string") {
        throw new JqRuntimeError(`jq: object keys must be strings, not ${jsonKind(key)}`);
      }
      for (const value of this.evaluate(entry.value, input)) {
        const next = new Map(built);
        next.set(key, value);
        yield* this.buildObject(entries, index + 1, next, input);
      }
    }
  }

  private member(target: JsonValue, name: string, optional: boolean): JsonValue | typeof SKIP {
    if (target === null) return null;
    if (target instanceof Map) return target.get(name) ?? null;
    if (optional) return SKIP;
    throw new JqRuntimeError(`jq: cannot index ${jsonKind(target)} with "${name}"`);
  }

  private at(target: JsonValue, index: JsonValue, optional: boolean): JsonValue | typeof SKIP {
    if (typeof index === "string") return this.member(target, index, optional);
    if (isJsonNumber(index)) {
      if (target === null) return null;
      if (!Array.isArray(target)) {
        if (optional) return SKIP;
        throw new JqRuntimeError(`jq: cannot index ${jsonKind(target)} with a number`);
      }
      const position = Math.trunc(numberOf(index));
      const resolved = position < 0 ? target.length + position : position;
      return target[resolved] ?? null;
    }
    if (optional) return SKIP;
    throw new JqRuntimeError(`jq: cannot index ${jsonKind(target)} with ${jsonKind(index)}`);
  }

  private slice(
    target: JsonValue,
    from: JsonValue,
    to: JsonValue,
    optional: boolean,
  ): JsonValue | typeof SKIP {
    if (target === null) return null;
    if (typeof target === "string") {
      const points = [...target];
      const start = clampIndex(from, 0, points.length);
      const end = clampIndex(to, points.length, points.length);
      return points.slice(start, Math.max(start, end)).join("");
    }
    if (Array.isArray(target)) {
      const start = clampIndex(from, 0, target.length);
      const end = clampIndex(to, target.length, target.length);
      return target.slice(start, Math.max(start, end));
    }
    if (optional) return SKIP;
    throw new JqRuntimeError(`jq: cannot slice ${jsonKind(target)}`);
  }

  private *call(node: Extract<Node, { kind: "call" }>, input: JsonValue): Generator<JsonValue> {
    const { name, args } = node;
    const arity = args.length;
    const one = (index: number): Node => {
      const argument = args[index];
      if (argument === undefined) throw new JqRuntimeError(`jq: ${name} is missing an argument`);
      return argument;
    };
    switch (`${name}/${arity}`) {
      case "empty/0":
        return;
      case "not/0":
        yield !isTruthy(input);
        return;
      case "type/0":
        yield jsonKind(input);
        return;
      case "length/0":
        yield lengthOf(input);
        return;
      case "keys/0":
      case "keys_unsorted/0": {
        const keys = keysOf(input);
        yield name === "keys" ? [...keys].sort((a, b) => compareJson(a, b)) : keys;
        return;
      }
      case "values/0":
        if (input !== null) yield input;
        return;
      case "has/1":
        for (const key of this.evaluate(one(0), input)) yield hasMember(input, key);
        return;
      case "select/1":
        for (const test of this.evaluate(one(0), input)) if (isTruthy(test)) yield input;
        return;
      case "map/1": {
        const items = requireArray(input, "map");
        const out: JsonValue[] = [];
        for (const item of items) out.push(...this.evaluate(one(0), item));
        yield out;
        return;
      }
      case "add/0": {
        let total: JsonValue = null;
        for (const item of requireArray(input, "add")) total = applyBinary("+", total, item);
        yield total;
        return;
      }
      case "join/1":
        for (const separator of this.evaluate(one(0), input)) {
          if (typeof separator !== "string") throw new JqRuntimeError("jq: join needs a string");
          yield requireArray(input, "join")
            .map((item) => (item === null ? "" : scalarText(item, "join")))
            .join(separator);
        }
        return;
      case "split/1":
        for (const separator of this.evaluate(one(0), input)) {
          if (typeof input !== "string" || typeof separator !== "string") {
            throw new JqRuntimeError("jq: split needs strings");
          }
          yield separator === "" ? [...input] : input.split(separator);
        }
        return;
      case "tostring/0":
        yield typeof input === "string" ? input : renderJson(input);
        return;
      case "tonumber/0":
        if (isJsonNumber(input)) {
          yield input;
          return;
        }
        if (typeof input === "string") {
          const parsed = Number(input.trim());
          if (input.trim() === "" || Number.isNaN(parsed)) {
            throw new JqRuntimeError(`jq: cannot parse ${JSON.stringify(input)} as a number`);
          }
          yield parsed;
          return;
        }
        throw new JqRuntimeError(`jq: cannot convert ${jsonKind(input)} to a number`);
      case "sort/0":
        yield [...requireArray(input, "sort")].sort(compareJson);
        return;
      case "sort_by/1": {
        const keyed = requireArray(input, "sort_by").map((item) => ({
          item,
          key: [...this.evaluate(one(0), item)],
        }));
        keyed.sort((a, b) => compareJson(a.key, b.key));
        yield keyed.map((entry) => entry.item);
        return;
      }
      case "unique/0": {
        const sorted = [...requireArray(input, "unique")].sort(compareJson);
        yield sorted.filter((item, index) => {
          const previous = sorted[index - 1];
          return previous === undefined || !equalJson(item, previous);
        });
        return;
      }
      case "min/0":
      case "max/0": {
        const items = requireArray(input, name);
        if (items.length === 0) {
          yield null;
          return;
        }
        yield items.reduce((best, item) => {
          const order = compareJson(item, best);
          return (name === "min" ? order < 0 : order > 0) ? item : best;
        });
        return;
      }
      case "reverse/0":
        yield [...requireArray(input, "reverse")].reverse();
        return;
      case "first/0": {
        const items = requireArray(input, "first");
        yield items.at(0) ?? null;
        return;
      }
      case "last/0": {
        const items = requireArray(input, "last");
        yield items.at(-1) ?? null;
        return;
      }
      case "any/0":
      case "all/0": {
        const items = requireArray(input, name);
        yield name === "any" ? items.some(isTruthy) : items.every(isTruthy);
        return;
      }
      case "range/1":
      case "range/2": {
        const froms =
          arity === 1
            ? [0]
            : [...this.evaluate(one(0), input)].map((v) => requireNumber(v, "range"));
        const tos = [...this.evaluate(one(arity - 1), input)].map((v) => requireNumber(v, "range"));
        for (const from of froms) {
          for (const to of tos) {
            for (let value = from; value < to; value += 1) yield value;
          }
        }
        return;
      }
      case "to_entries/0": {
        const object = requireObject(input, "to_entries");
        const out: JsonValue[] = [];
        for (const [key, value] of object) {
          out.push(
            new Map<string, JsonValue>([
              ["key", key],
              ["value", value],
            ]),
          );
        }
        yield out;
        return;
      }
      case "from_entries/0": {
        const built: JsonObject = new Map();
        for (const item of requireArray(input, "from_entries")) {
          const entry = requireObject(item, "from_entries");
          const key = entry.get("key") ?? entry.get("k") ?? entry.get("name") ?? null;
          const value = entry.get("value") ?? entry.get("v") ?? null;
          built.set(key === null ? "null" : scalarText(key, "from_entries"), value);
        }
        yield built;
        return;
      }
      case "flatten/0":
      case "flatten/1": {
        const depths =
          arity === 0
            ? [1e9]
            : [...this.evaluate(one(0), input)].map((v) => requireNumber(v, "flatten"));
        for (const depth of depths) yield flatten(requireArray(input, "flatten"), depth);
        return;
      }
      default:
        throw new JqSyntaxError(`jq: ${name}/${arity} is not a function in this profile`);
    }
  }
}

const SKIP = Symbol("skip");

function clampIndex(value: JsonValue, fallback: number, length: number): number {
  if (value === null) return fallback;
  if (!isJsonNumber(value)) throw new JqRuntimeError("jq: slice bounds must be numbers");
  const position = Math.trunc(numberOf(value));
  const resolved = position < 0 ? length + position : position;
  return Math.min(Math.max(resolved, 0), length);
}

function requireNumber(value: JsonValue, what: string): number {
  if (!isJsonNumber(value)) throw new JqRuntimeError(`jq: ${jsonKind(value)} cannot be ${what}`);
  return numberOf(value);
}

function requireArray(value: JsonValue, what: string): JsonValue[] {
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

function scalarText(value: JsonValue, what: string): string {
  if (typeof value === "string") return value;
  if (isJsonNumber(value) || typeof value === "boolean" || value === null) return renderJson(value);
  throw new JqRuntimeError(`jq: ${what} cannot use ${jsonKind(value)} here`);
}

function lengthOf(value: JsonValue): JsonValue {
  if (value === null) return 0;
  if (typeof value === "boolean") throw new JqRuntimeError("jq: boolean has no length");
  if (isJsonNumber(value)) return Math.abs(numberOf(value));
  if (typeof value === "string") return [...value].length;
  return Array.isArray(value) ? value.length : value.size;
}

function keysOf(value: JsonValue): JsonValue[] {
  if (value instanceof Map) return [...value.keys()];
  if (Array.isArray(value)) return value.map((_item, index) => index);
  throw new JqRuntimeError(`jq: ${jsonKind(value)} has no keys`);
}

function hasMember(value: JsonValue, key: JsonValue): boolean {
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

function flatten(items: JsonValue[], depth: number): JsonValue[] {
  const out: JsonValue[] = [];
  for (const item of items) {
    if (Array.isArray(item) && depth > 0) out.push(...flatten(item, depth - 1));
    else out.push(item);
  }
  return out;
}

function applyBinary(operator: BinaryOperator, left: JsonValue, right: JsonValue): JsonValue {
  switch (operator) {
    case "==":
      return equalJson(left, right);
    case "!=":
      return !equalJson(left, right);
    case "<":
      return compareJson(left, right) < 0;
    case "<=":
      return compareJson(left, right) <= 0;
    case ">":
      return compareJson(left, right) > 0;
    case ">=":
      return compareJson(left, right) >= 0;
    case "+":
      return add(left, right);
    case "-":
      return subtract(left, right);
    case "*":
      return multiply(left, right);
    case "/":
      return divide(left, right);
    default:
      return modulo(left, right);
  }
}

function add(left: JsonValue, right: JsonValue): JsonValue {
  if (left === null) return right;
  if (right === null) return left;
  if (isJsonNumber(left) && isJsonNumber(right)) return numberOf(left) + numberOf(right);
  if (typeof left === "string" && typeof right === "string") return left + right;
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  if (left instanceof Map && right instanceof Map) {
    const merged = new Map(left);
    for (const [key, value] of right) merged.set(key, value);
    return merged;
  }
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be added`);
}

function subtract(left: JsonValue, right: JsonValue): JsonValue {
  if (isJsonNumber(left) && isJsonNumber(right)) return numberOf(left) - numberOf(right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.filter((item) => !right.some((excluded) => equalJson(item, excluded)));
  }
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be subtracted`);
}

function multiply(left: JsonValue, right: JsonValue): JsonValue {
  if (isJsonNumber(left) && isJsonNumber(right)) return numberOf(left) * numberOf(right);
  if (left instanceof Map && right instanceof Map) return deepMerge(left, right);
  const [text, count] =
    typeof left === "string" && isJsonNumber(right)
      ? [left, numberOf(right)]
      : typeof right === "string" && isJsonNumber(left)
        ? [right, numberOf(left)]
        : [undefined, 0];
  if (text !== undefined) return count <= 0 ? null : text.repeat(Math.trunc(count));
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be multiplied`);
}

function deepMerge(left: JsonObject, right: JsonObject): JsonObject {
  const merged = new Map(left);
  for (const [key, value] of right) {
    const existing = merged.get(key);
    merged.set(
      key,
      existing instanceof Map && value instanceof Map ? deepMerge(existing, value) : value,
    );
  }
  return merged;
}

function divide(left: JsonValue, right: JsonValue): JsonValue {
  if (isJsonNumber(left) && isJsonNumber(right)) {
    const divisor = numberOf(right);
    if (divisor === 0) throw new JqRuntimeError("jq: cannot divide by zero");
    return numberOf(left) / divisor;
  }
  if (typeof left === "string" && typeof right === "string") {
    return right === "" ? [...left] : left.split(right);
  }
  throw new JqRuntimeError(`jq: ${jsonKind(left)} and ${jsonKind(right)} cannot be divided`);
}

function modulo(left: JsonValue, right: JsonValue): JsonValue {
  const divisor = Math.trunc(requireNumber(right, "a divisor"));
  if (divisor === 0) throw new JqRuntimeError("jq: cannot divide by zero");
  return Math.trunc(requireNumber(left, "a dividend")) % divisor;
}

/** Parses one `--argjson` value, which is ordinary JSON. */
export function parseJqArgument(text: string): JsonValue {
  return parseJsonText(text, "jq");
}
