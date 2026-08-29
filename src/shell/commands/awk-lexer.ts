import { VfsError } from "../../core/errors.js";

export type AwkTokenKind =
  | "number"
  | "string"
  | "identifier"
  | "regex"
  | "operator"
  | "newline"
  | "eof";

export interface AwkToken {
  readonly kind: AwkTokenKind;
  readonly value: string;
  readonly offset: number;
}

export class AwkSyntaxError extends VfsError {
  constructor(message: string, offset: number) {
    super("EINVAL", `awk: ${message} at offset ${offset}`);
    this.name = "AwkSyntaxError";
  }
}

const NON_EXPRESSION_IDENTIFIERS = new Set([
  "BEGIN",
  "END",
  "else",
  "exit",
  "break",
  "continue",
  "delete",
  "do",
  "for",
  "if",
  "in",
  "next",
  "print",
  "printf",
  "while",
]);
const TWO_CHARACTER_OPERATORS = new Set([
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "!~",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "^=",
  "++",
  "--",
]);

function decodeEscape(character: string): string {
  if (character === "n") return "\n";
  if (character === "t") return "\t";
  if (character === "r") return "\r";
  if (character === "b") return "\b";
  if (character === "f") return "\f";
  if (character === "v") return "\v";
  return character;
}

function isNumberStart(source: string, index: number): boolean {
  const character = source[index] ?? "";
  return /[0-9]/u.test(character) || (character === "." && /[0-9]/u.test(source[index + 1] ?? ""));
}

class AwkLexer {
  private readonly tokens: AwkToken[] = [];
  private index = 0;
  private canEndExpression = false;

  constructor(private readonly source: string) {}

  private push(kind: AwkTokenKind, value: string, offset: number): void {
    this.tokens.push({ kind, value, offset });
    if (kind === "number" || kind === "string" || kind === "regex") this.canEndExpression = true;
    else if (kind === "identifier") this.canEndExpression = !NON_EXPRESSION_IDENTIFIERS.has(value);
    else this.canEndExpression = kind === "operator" && [")", "]", "++", "--"].includes(value);
  }

  private string(offset: number): void {
    this.index += 1;
    let value = "";
    while (this.index < this.source.length) {
      const next = this.source[this.index++] ?? "";
      if (next === '"') {
        this.push("string", value, offset);
        return;
      }
      if (next === "\n") throw new AwkSyntaxError("newline in string literal", offset);
      if (next !== "\\") value += next;
      else {
        const escaped = this.source[this.index++];
        if (escaped === undefined) throw new AwkSyntaxError("unterminated string literal", offset);
        value += decodeEscape(escaped);
      }
    }
    throw new AwkSyntaxError("unterminated string literal", offset);
  }

  private regex(offset: number): void {
    this.index += 1;
    let pattern = "";
    while (this.index < this.source.length) {
      const next = this.source[this.index++] ?? "";
      if (next === "\n") throw new AwkSyntaxError("newline in regular expression", offset);
      if (next === "/") {
        this.push("regex", pattern, offset);
        return;
      }
      if (next !== "\\") pattern += next;
      else {
        const escaped = this.source[this.index++];
        if (escaped === undefined) break;
        pattern += `\\${escaped}`;
      }
    }
    throw new AwkSyntaxError("unterminated regular expression", offset);
  }

  private number(offset: number): void {
    const value = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u.exec(
      this.source.slice(this.index),
    )?.[0];
    if (value === undefined) throw new AwkSyntaxError("invalid number", offset);
    this.index += value.length;
    this.push("number", value, offset);
  }

  private identifier(offset: number): void {
    const value = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.source.slice(this.index))?.[0] ?? "";
    this.index += value.length;
    this.push("identifier", value, offset);
  }

  private operator(offset: number): boolean {
    const pair = this.source.slice(this.index, this.index + 2);
    if (TWO_CHARACTER_OPERATORS.has(pair)) {
      this.index += 2;
      this.push("operator", pair, offset);
      return true;
    }
    const character = this.source[this.index] ?? "";
    if (!"{}()[]$,;?:+-*/%^<>=!~".includes(character)) return false;
    this.index += 1;
    this.push("operator", character, offset);
    return true;
  }

  private next(): void {
    const offset = this.index;
    const character = this.source[this.index] ?? "";
    if (character === " " || character === "\t" || character === "\r") this.index += 1;
    else if (character === "\n") {
      this.index += 1;
      this.push("newline", "\n", offset);
    } else if (character === "#") {
      const newline = this.source.indexOf("\n", this.index);
      this.index = newline < 0 ? this.source.length : newline;
    } else if (character === '"') this.string(offset);
    else if (isNumberStart(this.source, this.index)) this.number(offset);
    else if (/[A-Za-z_]/u.test(character)) this.identifier(offset);
    else if (character === "/" && !this.canEndExpression) this.regex(offset);
    else if (!this.operator(offset))
      throw new AwkSyntaxError(`unexpected character ${character}`, offset);
  }

  tokenize(): AwkToken[] {
    while (this.index < this.source.length) this.next();
    this.tokens.push({ kind: "eof", value: "", offset: this.source.length });
    return this.tokens;
  }
}

/** Tokenizes the finite profile and distinguishes ERE literals from division. */
export function tokenizeAwk(source: string): AwkToken[] {
  return new AwkLexer(source).tokenize();
}
