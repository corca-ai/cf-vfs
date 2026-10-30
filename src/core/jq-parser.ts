import { JqSyntaxError } from "./jq-errors.js";
import { type JqToken, tokenizeJq } from "./jq-lexer.js";
import type { JsonValue } from "./json-value.js";

const MAX_NODES = 2048;

export type JqNode =
  | { readonly kind: "identity" }
  | {
      readonly kind: "field";
      readonly name: string;
      readonly optional: boolean;
      readonly of: JqNode;
    }
  | {
      readonly kind: "index";
      readonly of: JqNode;
      readonly index: JqNode;
      readonly optional: boolean;
    }
  | {
      readonly kind: "slice";
      readonly of: JqNode;
      readonly from: JqNode | undefined;
      readonly to: JqNode | undefined;
      readonly optional: boolean;
    }
  | { readonly kind: "iterate"; readonly of: JqNode; readonly optional: boolean }
  | { readonly kind: "literal"; readonly value: JsonValue }
  | { readonly kind: "pipe"; readonly left: JqNode; readonly right: JqNode }
  | { readonly kind: "comma"; readonly left: JqNode; readonly right: JqNode }
  | { readonly kind: "alternative"; readonly left: JqNode; readonly right: JqNode }
  | {
      readonly kind: "binary";
      readonly operator: JqBinaryOperator;
      readonly left: JqNode;
      readonly right: JqNode;
    }
  | { readonly kind: "negate"; readonly of: JqNode }
  | { readonly kind: "array"; readonly body: JqNode | undefined }
  | { readonly kind: "object"; readonly entries: readonly JqObjectEntry[] }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly JqNode[] }
  | { readonly kind: "variable"; readonly name: string }
  /** A string with interpolations, each rendered by `format` (`text` when absent). */
  | {
      readonly kind: "template";
      readonly parts: readonly (string | JqNode)[];
      readonly format: string | undefined;
    }
  /** `@name` applied to the input. */
  | { readonly kind: "format"; readonly name: string };

export interface JqObjectEntry {
  readonly key: JqNode;
  readonly value: JqNode;
}

export type JqBinaryOperator =
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
  "ascii_downcase",
  "ascii_upcase",
  "endswith",
  "ltrimstr",
  "rtrimstr",
  "startswith",
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

/** `jq` matches these with Oniguruma; this repository has a POSIX engine, so they are refused. */
const REGEX_BUILTINS = new Set(["test", "match", "capture", "scan", "splits", "sub", "gsub"]);

/** Formats this profile leaves out; any other unknown name fails when it runs, as in `jq`. */
const REFUSED_FORMATS = new Set(["base64d", "urid"]);

type TemplateToken = Extract<JqToken, { type: "string" | "template" }>;

class Parser {
  private offset = 0;
  private nodes = 0;

  constructor(
    private readonly tokens: readonly JqToken[],
    /** The parser whose node count an interpolation shares. */
    private readonly root?: Parser,
  ) {}

  private peek(): JqToken {
    return this.tokens[this.offset] ?? { type: "end" };
  }

  private take(): JqToken {
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
    const owner = this.root ?? this;
    owner.nodes += 1;
    if (owner.nodes > MAX_NODES) throw new JqSyntaxError("jq: filter is too large");
  }

  /** A string, plain or interpolated, rendered with `format`. */
  private template(token: TemplateToken, format: string | undefined): JqNode {
    if (token.type === "string" && format === undefined) {
      return { kind: "literal", value: token.value };
    }
    const parts =
      token.type === "string"
        ? [token.value]
        : token.parts.map((part) =>
            typeof part === "string" ? part : new Parser(part, this.root ?? this).parse(),
          );
    return { kind: "template", parts, format };
  }

  private formatPrimary(name: string): JqNode {
    if (REFUSED_FORMATS.has(name)) {
      throw new JqSyntaxError(`jq: @${name} is not supported by this profile`);
    }
    const next = this.peek();
    if (next.type === "string" || next.type === "template") {
      this.take();
      return this.template(next, name);
    }
    return { kind: "format", name };
  }

  parse(): JqNode {
    const node = this.pipe();
    if (this.peek().type !== "end") throw new JqSyntaxError("jq: unexpected trailing input");
    return node;
  }

  private pipe(): JqNode {
    let left = this.comma();
    while (this.eat("|")) {
      this.count();
      left = { kind: "pipe", left, right: this.comma() };
    }
    return left;
  }

  private comma(): JqNode {
    let left = this.alternative();
    while (this.eat(",")) {
      this.count();
      left = { kind: "comma", left, right: this.alternative() };
    }
    return left;
  }

  private alternative(): JqNode {
    let left = this.or();
    while (this.eat("//")) {
      this.count();
      left = { kind: "alternative", left, right: this.or() };
    }
    return left;
  }

  private or(): JqNode {
    let left = this.and();
    for (;;) {
      const token = this.peek();
      if (token.type !== "ident" || token.value !== "or") return left;
      this.take();
      this.count();
      left = { kind: "binary", operator: "or", left, right: this.and() };
    }
  }

  private and(): JqNode {
    let left = this.comparison();
    for (;;) {
      const token = this.peek();
      if (token.type !== "ident" || token.value !== "and") return left;
      this.take();
      this.count();
      left = { kind: "binary", operator: "and", left, right: this.comparison() };
    }
  }

  private comparison(): JqNode {
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

  private additive(): JqNode {
    let left = this.multiplicative();
    for (;;) {
      const operator = this.at("+") ? "+" : this.at("-") ? "-" : undefined;
      if (operator === undefined) return left;
      this.take();
      this.count();
      left = { kind: "binary", operator, left, right: this.multiplicative() };
    }
  }

  private multiplicative(): JqNode {
    let left = this.unary();
    for (;;) {
      const operator = this.at("*") ? "*" : this.at("/") ? "/" : this.at("%") ? "%" : undefined;
      if (operator === undefined) return left;
      this.take();
      this.count();
      left = { kind: "binary", operator, left, right: this.unary() };
    }
  }

  private unary(): JqNode {
    if (this.eat("-")) {
      this.count();
      return { kind: "negate", of: this.unary() };
    }
    return this.postfix(this.primary());
  }

  /** `.a`, `[0]`, `[]`, `[a:b]`, and `?`, applied left to right. */
  private postfix(start: JqNode): JqNode {
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

  private bracket(of: JqNode): JqNode {
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

  private primary(): JqNode {
    this.count();
    const token = this.peek();
    switch (token.type) {
      case "number":
        this.take();
        return { kind: "literal", value: token.value };
      case "string":
      case "template":
        this.take();
        return this.template(token, undefined);
      case "format":
        this.take();
        return this.formatPrimary(token.value);
      case "variable":
        this.take();
        return { kind: "variable", name: token.value };
      case "punct":
        return this.punctuationPrimary(token.value);
      case "ident":
        return this.identifierPrimary(token.value);
      default:
        throw new JqSyntaxError("jq: unexpected end of filter");
    }
  }

  private punctuationPrimary(value: string): JqNode {
    if (value === ".") return this.dotPrimary();
    if (value === "(") return this.parenthesizedPrimary();
    if (value === "[") return this.arrayPrimary();
    if (value === "{") {
      this.take();
      return this.objectConstruction();
    }
    throw new JqSyntaxError("jq: unexpected end of filter");
  }

  private dotPrimary(): JqNode {
    this.take();
    const next = this.peek();
    if (next.type === "ident") {
      this.take();
      return { kind: "field", name: next.value, optional: false, of: { kind: "identity" } };
    }
    if (next.type === "string" || next.type === "template") {
      this.take();
      return {
        kind: "index",
        of: { kind: "identity" },
        index: this.template(next, undefined),
        optional: false,
      };
    }
    if (next.type === "punct" && next.value === ".") {
      throw new JqSyntaxError("jq: recursive descent .. is not supported by this profile");
    }
    return { kind: "identity" };
  }

  private parenthesizedPrimary(): JqNode {
    this.take();
    const inner = this.pipe();
    this.expect(")");
    return inner;
  }

  private arrayPrimary(): JqNode {
    this.take();
    if (this.eat("]")) return { kind: "array", body: undefined };
    const body = this.pipe();
    this.expect("]");
    return { kind: "array", body };
  }

  private identifierPrimary(name: string): JqNode {
    const refused = REFUSED.get(name);
    if (refused !== undefined) {
      throw new JqSyntaxError(`jq: ${refused} is not supported by this profile`);
    }
    this.take();
    const literal = keywordLiteral(name);
    if (literal !== undefined) return literal;
    const args: JqNode[] = [];
    if (this.eat("(")) {
      args.push(this.pipe());
      while (this.eat(";")) args.push(this.pipe());
      this.expect(")");
    }
    if (REGEX_BUILTINS.has(name)) {
      throw new JqSyntaxError(
        `jq: ${name} uses regular expressions, which this profile leaves out; use grep, sed or awk`,
      );
    }
    if (!BUILTIN_NAMES.has(name)) {
      throw new JqSyntaxError(`jq: ${name} is not a function in this profile`);
    }
    return { kind: "call", name, args };
  }

  /** One object key and the value its shorthand implies, if it has one. */
  private objectKey(): { key: JqNode; value: JqNode | undefined } {
    const token = this.take();
    if (token.type === "ident") {
      // `{a}` is shorthand for `{a: .a}`, which is the common spelling.
      return {
        key: { kind: "literal", value: token.value },
        value: { kind: "field", name: token.value, optional: false, of: { kind: "identity" } },
      };
    }
    if (token.type === "string" || token.type === "template") {
      const key = this.template(token, undefined);
      return {
        key,
        value: { kind: "index", of: { kind: "identity" }, index: key, optional: false },
      };
    }
    if (token.type === "variable") {
      return {
        key: { kind: "literal", value: token.value },
        value: { kind: "variable", name: token.value },
      };
    }
    if (token.type === "punct" && token.value === "(") {
      const key = this.pipe();
      this.expect(")");
      return { key, value: undefined };
    }
    throw new JqSyntaxError("jq: expected an object key");
  }

  private objectConstruction(): JqNode {
    const entries: JqObjectEntry[] = [];
    if (this.eat("}")) return { kind: "object", entries };
    for (;;) {
      const entry = this.objectKey();
      const value = this.eat(":") ? this.alternative() : entry.value;
      if (value === undefined) throw new JqSyntaxError("jq: expected a value for the object key");
      entries.push({ key: entry.key, value });
      if (this.eat(",")) continue;
      this.expect("}");
      return { kind: "object", entries };
    }
  }
}

function keywordLiteral(name: string): JqNode | undefined {
  if (name === "true") return { kind: "literal", value: true };
  if (name === "false") return { kind: "literal", value: false };
  if (name === "null") return { kind: "literal", value: null };
  return undefined;
}

function withOptional(node: JqNode): JqNode {
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

/** Bounds nesting, counting each interpolation as one more level inside its string. */
function nestingChange(token: JqToken): number {
  if (token.type !== "punct") return 0;
  if (["(", "[", "{"].includes(token.value)) return 1;
  return [")", "]", "}"].includes(token.value) ? -1 : 0;
}

function checkNesting(tokens: readonly JqToken[], outer: number): void {
  let depth = outer;
  for (const token of tokens) {
    const parts = token.type === "template" ? token.parts : [];
    for (const part of parts) if (typeof part !== "string") checkNesting(part, depth + 1);
    depth += nestingChange(token);
    if (depth > 64) throw new JqSyntaxError("jq: syntax nesting limit exceeded");
  }
}

export function parseJqNode(source: string): JqNode {
  const tokens = tokenizeJq(source);
  checkNesting(tokens, 0);
  return new Parser(tokens).parse();
}
