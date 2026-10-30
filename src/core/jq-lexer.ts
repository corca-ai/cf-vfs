import { JqSyntaxError } from "./jq-errors.js";

export type JqToken =
  | { readonly type: "punct"; readonly value: string }
  | { readonly type: "ident"; readonly value: string }
  | { readonly type: "variable"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "string"; readonly value: string }
  /** A string with `\(…)` interpolations: literal text and each embedded filter's tokens. */
  | { readonly type: "template"; readonly parts: readonly (string | readonly JqToken[])[] }
  | { readonly type: "format"; readonly value: string }
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
] as const;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/u;
const NUMBER = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
};

class Lexer {
  private offset = 0;

  constructor(private readonly source: string) {}

  tokenize(): JqToken[] {
    const tokens: JqToken[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.offset >= this.source.length) break;
      tokens.push(this.token());
    }
    tokens.push({ type: "end" });
    return tokens;
  }

  private skipIgnored(): void {
    for (;;) {
      while (/\s/u.test(this.source[this.offset] ?? "")) this.offset += 1;
      if (this.source[this.offset] !== "#") return;
      const newline = this.source.indexOf("\n", this.offset);
      this.offset = newline < 0 ? this.source.length : newline + 1;
    }
  }

  private token(): JqToken {
    const character = this.source[this.offset] ?? "";
    if (character === '"') return this.string();
    if (character === "$") return this.variable();
    if (character === "@") return this.format();
    const identifier = IDENT.exec(this.source.slice(this.offset));
    if (identifier !== null) {
      return this.advance({ type: "ident", value: identifier[0] }, identifier[0].length);
    }
    const numeric =
      /[0-9]/u.test(character) ||
      (character === "." && /[0-9]/u.test(this.source[this.offset + 1] ?? ""));
    const number = numeric ? NUMBER.exec(this.source.slice(this.offset)) : null;
    if (number !== null) {
      return this.advance({ type: "number", value: Number(number[0]) }, number[0].length);
    }
    const punct = PUNCTUATION.find((candidate) => this.source.startsWith(candidate, this.offset));
    if (punct === undefined) {
      throw new JqSyntaxError(`jq: unexpected character ${JSON.stringify(character)}`);
    }
    return this.advance({ type: "punct", value: punct }, punct.length);
  }

  private advance<T extends JqToken>(token: T, width: number): T {
    this.offset += width;
    return token;
  }

  private variable(): JqToken {
    const name = IDENT.exec(this.source.slice(this.offset + 1));
    if (name === null) throw new JqSyntaxError("jq: $ must name a variable");
    this.offset += 1 + name[0].length;
    return { type: "variable", value: name[0] };
  }

  private format(): JqToken {
    const name = IDENT.exec(this.source.slice(this.offset + 1));
    if (name === null) throw new JqSyntaxError("jq: @ must name a format");
    this.offset += 1 + name[0].length;
    return { type: "format", value: name[0] };
  }

  private string(): JqToken {
    this.offset += 1;
    const parts: (string | readonly JqToken[])[] = [];
    let value = "";
    while (this.offset < this.source.length) {
      const character = this.source[this.offset] ?? "";
      if (character === '"') {
        this.offset += 1;
        if (parts.length === 0) return { type: "string", value };
        parts.push(value);
        return { type: "template", parts };
      }
      if (character === "\\" && this.source[this.offset + 1] === "(") {
        parts.push(value, this.interpolation());
        value = "";
        continue;
      }
      value += character === "\\" ? this.escape() : character;
      this.offset += character === "\\" ? 0 : 1;
    }
    throw new JqSyntaxError("jq: unterminated string");
  }

  /** The tokens of one `\(…)`, up to its closing parenthesis. */
  private interpolation(): JqToken[] {
    this.offset += 2;
    const tokens: JqToken[] = [];
    let depth = 0;
    for (;;) {
      this.skipIgnored();
      if (this.offset >= this.source.length) throw new JqSyntaxError("jq: unterminated string");
      if (this.source[this.offset] === ")" && depth === 0) {
        this.offset += 1;
        tokens.push({ type: "end" });
        return tokens;
      }
      const token = this.token();
      if (token.type === "punct" && token.value === "(") depth += 1;
      if (token.type === "punct" && token.value === ")") depth -= 1;
      tokens.push(token);
    }
  }

  private escape(): string {
    const marker = this.source[this.offset + 1];
    if (marker === "u") return this.unicodeEscape();
    const replacement = marker === undefined ? undefined : ESCAPES[marker];
    if (replacement === undefined) throw new JqSyntaxError("jq: invalid escape in string");
    this.offset += 2;
    return replacement;
  }

  private unicodeEscape(): string {
    const code = this.source.slice(this.offset + 2, this.offset + 6);
    if (!/^[0-9a-fA-F]{4}$/u.test(code)) throw new JqSyntaxError("jq: invalid unicode escape");
    this.offset += 6;
    return String.fromCharCode(Number.parseInt(code, 16));
  }
}

export function tokenizeJq(source: string): JqToken[] {
  return new Lexer(source).tokenize();
}
