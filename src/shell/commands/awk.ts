import { VfsError } from "../../core/errors.js";
import { compareUtf8 } from "../../core/path.js";
import { compilePosixRegex, type PosixRegex } from "../../core/posix-regex.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { BufferedTextWriter, inputStreams, readFileText, readTextLines } from "./helpers.js";

const AWK = {
  name: "awk",
  usage: "[-F SEPARATOR] [-v NAME=VALUE] [-f PROGRAM_FILE] [PROGRAM] [FILE...]",
  summary: "scans records with a bounded subset of the AWK language",
  options: {
    short: {
      F: { name: "field-separator", argument: true },
      v: { name: "assign", argument: true },
      f: { name: "program-file", argument: true },
    },
    stopAtFirstOperand: true,
  },
} as const satisfies AppletSpecWithOptions<"field-separator" | "assign" | "program-file">;

const AWK_ENCODER = new TextEncoder();

type TokenKind = "number" | "string" | "identifier" | "regex" | "operator" | "newline" | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly offset: number;
}

class AwkSyntaxError extends VfsError {
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

/** Tokenizes the finite profile and distinguishes ERE literals from division. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let canEndExpression = false;
  const push = (kind: TokenKind, value: string, offset: number): void => {
    tokens.push({ kind, value, offset });
    if (kind === "number" || kind === "string" || kind === "regex") canEndExpression = true;
    else if (kind === "identifier") canEndExpression = !NON_EXPRESSION_IDENTIFIERS.has(value);
    else if (kind === "newline") canEndExpression = false;
    else if (kind === "operator") {
      if (value === ")" || value === "]" || value === "++" || value === "--") {
        canEndExpression = true;
      } else if (value === ";") canEndExpression = false;
      else canEndExpression = false;
    }
  };

  while (index < source.length) {
    const offset = index;
    const character = source[index] ?? "";
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\n") {
      push("newline", "\n", index++);
      continue;
    }
    if (character === "#") {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (character === '"') {
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const next = source[index++] ?? "";
        if (next === '"') {
          closed = true;
          break;
        }
        if (next === "\n") throw new AwkSyntaxError("newline in string literal", offset);
        if (next !== "\\") {
          value += next;
          continue;
        }
        const escaped = source[index++];
        if (escaped === undefined) throw new AwkSyntaxError("unterminated string literal", offset);
        value += decodeEscape(escaped);
      }
      if (!closed) throw new AwkSyntaxError("unterminated string literal", offset);
      push("string", value, offset);
      continue;
    }
    if (/[0-9]/u.test(character) || (character === "." && /[0-9]/u.test(source[index + 1] ?? ""))) {
      const value = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u.exec(
        source.slice(index),
      )?.[0];
      if (value === undefined) throw new AwkSyntaxError("invalid number", offset);
      index += value.length;
      push("number", value, offset);
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const value = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index))?.[0] ?? "";
      index += value.length;
      push("identifier", value, offset);
      continue;
    }
    if (character === "/" && !canEndExpression) {
      index += 1;
      let pattern = "";
      let closed = false;
      while (index < source.length) {
        const next = source[index++] ?? "";
        if (next === "\n") throw new AwkSyntaxError("newline in regular expression", offset);
        if (next === "/") {
          closed = true;
          break;
        }
        if (next === "\\") {
          const escaped = source[index++];
          if (escaped === undefined) break;
          pattern += `\\${escaped}`;
        } else pattern += next;
      }
      if (!closed) throw new AwkSyntaxError("unterminated regular expression", offset);
      push("regex", pattern, offset);
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (TWO_CHARACTER_OPERATORS.has(pair)) {
      index += 2;
      push("operator", pair, offset);
      continue;
    }
    if ("{}()[]$,;?:+-*/%^<>=!~".includes(character)) {
      index += 1;
      push("operator", character, offset);
      continue;
    }
    throw new AwkSyntaxError(`unexpected character ${character}`, offset);
  }
  tokens.push({ kind: "eof", value: "", offset: source.length });
  return tokens;
}

type AssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=";

type Expression =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "regex"; readonly pattern: PosixRegex }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "field"; readonly index: Expression }
  | { readonly kind: "tuple"; readonly values: readonly Expression[] }
  | {
      readonly kind: "array";
      readonly name: string;
      readonly indices: readonly Expression[];
    }
  | { readonly kind: "in"; readonly key: Expression; readonly array: string }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly arguments: readonly Expression[];
    }
  | {
      readonly kind: "unary";
      readonly operator: "!" | "+" | "-";
      readonly operand: Expression;
    }
  | {
      readonly kind: "binary";
      readonly operator:
        | "+"
        | "-"
        | "*"
        | "/"
        | "%"
        | "^"
        | "=="
        | "!="
        | "<"
        | "<="
        | ">"
        | ">="
        | "~"
        | "!~"
        | "&&"
        | "||"
        | "concat";
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "conditional";
      readonly condition: Expression;
      readonly consequent: Expression;
      readonly alternate: Expression;
    }
  | {
      readonly kind: "assign";
      readonly target: LValue;
      readonly operator: AssignmentOperator;
      readonly value: Expression;
    }
  | {
      readonly kind: "update";
      readonly target: LValue;
      readonly delta: 1 | -1;
      readonly prefix: boolean;
    };

type LValue = Extract<Expression, { kind: "variable" | "field" | "array" }>;

type Statement =
  | { readonly kind: "print"; readonly values: readonly Expression[] }
  | { readonly kind: "printf"; readonly values: readonly Expression[] }
  | { readonly kind: "expression"; readonly expression: Expression }
  | {
      readonly kind: "if";
      readonly condition: Expression;
      readonly consequent: readonly Statement[];
      readonly alternate: readonly Statement[];
    }
  | {
      readonly kind: "while";
      readonly condition: Expression;
      readonly body: readonly Statement[];
    }
  | {
      readonly kind: "do";
      readonly body: readonly Statement[];
      readonly condition: Expression;
    }
  | {
      readonly kind: "for";
      readonly initialize?: Expression;
      readonly condition?: Expression;
      readonly update?: Expression;
      readonly body: readonly Statement[];
    }
  | {
      readonly kind: "for-in";
      readonly variable: string;
      readonly array: string;
      readonly body: readonly Statement[];
    }
  | {
      readonly kind: "delete";
      readonly target: Extract<LValue, { kind: "array" }>;
    }
  | { readonly kind: "break" }
  | { readonly kind: "continue" }
  | { readonly kind: "next" }
  | { readonly kind: "exit"; readonly status?: Expression };

interface Rule {
  readonly phase: "begin" | "record" | "end";
  readonly pattern?: Expression;
  readonly rangeEnd?: Expression;
  /** Missing means AWK's default `{ print $0 }` action. */
  readonly action?: readonly Statement[];
}

const BUILTINS = new Set([
  "gsub",
  "index",
  "int",
  "length",
  "match",
  "split",
  "sprintf",
  "sub",
  "substr",
  "tolower",
  "toupper",
]);

class Parser {
  private index = 0;
  private nodes = 0;
  private depth = 0;
  private loopDepth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly maximumNodes: number,
    private readonly maximumDepth: number,
  ) {}

  parse(): Rule[] {
    const rules: Rule[] = [];
    this.separators();
    while (!this.at("eof")) {
      const rule = this.rule();
      rules.push(rule);
      if (
        rule.action === undefined &&
        !this.at("eof") &&
        !this.at("newline") &&
        !this.atOperator(";")
      ) {
        this.fail("expected a rule separator");
      }
      this.separators();
    }
    return rules;
  }

  private node<T>(value: T): T {
    this.nodes += 1;
    if (this.nodes > this.maximumNodes) this.fail("program node limit exceeded");
    return value;
  }

  private nested<T>(read: () => T): T {
    this.depth += 1;
    if (this.depth > this.maximumDepth) this.fail("program nesting limit exceeded");
    try {
      return read();
    } finally {
      this.depth -= 1;
    }
  }

  private current(): Token {
    return (
      this.tokens[this.index] ??
      this.tokens[this.tokens.length - 1] ?? {
        kind: "eof",
        value: "",
        offset: 0,
      }
    );
  }

  private at(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private atIdentifier(value?: string): boolean {
    return this.at("identifier") && (value === undefined || this.current().value === value);
  }

  private nextIsIdentifier(value: string): boolean {
    const token = this.tokens[this.index + 1];
    return token?.kind === "identifier" && token.value === value;
  }

  private atOperator(value: string): boolean {
    return this.at("operator") && this.current().value === value;
  }

  private take(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }

  private expectOperator(value: string): void {
    if (!this.atOperator(value)) this.fail(`expected ${value}`);
    this.take();
  }

  private fail(message: string, token = this.current()): never {
    throw new AwkSyntaxError(message, token.offset);
  }

  private separators(): void {
    while (this.at("newline") || this.atOperator(";")) this.take();
  }

  private rule(): Rule {
    if (this.atIdentifier("BEGIN") || this.atIdentifier("END")) {
      const phase = this.take().value === "BEGIN" ? "begin" : "end";
      if (!this.atOperator("{")) this.fail(`${phase.toUpperCase()} requires an action`);
      return this.node({ phase, action: this.block() });
    }
    if (this.atOperator("{")) return this.node({ phase: "record", action: this.block() });
    const pattern = this.expression();
    let rangeEnd: Expression | undefined;
    if (this.atOperator(",")) {
      this.take();
      rangeEnd = this.expression();
    }
    const action = this.atOperator("{") ? this.block() : undefined;
    return this.node({
      phase: "record",
      pattern,
      ...(rangeEnd === undefined ? {} : { rangeEnd }),
      ...(action === undefined ? {} : { action }),
    });
  }

  private block(): Statement[] {
    return this.nested(() => {
      this.expectOperator("{");
      const statements: Statement[] = [];
      this.separators();
      while (!this.atOperator("}")) {
        if (this.at("eof")) this.fail("unterminated action");
        const statement = this.statement();
        statements.push(statement);
        if (
          !this.atOperator("}") &&
          !this.at("newline") &&
          !this.atOperator(";") &&
          !["if", "while", "do", "for", "for-in"].includes(statement.kind)
        ) {
          this.fail("expected a statement separator");
        }
        this.separators();
      }
      this.take();
      return statements;
    });
  }

  private statementBody(): Statement[] {
    if (this.atOperator("{")) return this.block();
    return [this.statement()];
  }

  private loopBody(): Statement[] {
    this.loopDepth += 1;
    try {
      return this.statementBody();
    } finally {
      this.loopDepth -= 1;
    }
  }

  private statement(): Statement {
    if (this.atIdentifier("print") || this.atIdentifier("printf")) {
      const kind = this.take().value as "print" | "printf";
      const parenthesized = this.atOperator("(");
      if (parenthesized) this.take();
      const values: Expression[] = [];
      const atEnd = (): boolean =>
        parenthesized
          ? this.atOperator(")")
          : this.atOperator("}") || this.atOperator(";") || this.at("newline") || this.at("eof");
      while (!atEnd()) {
        values.push(this.expression());
        if (!this.atOperator(",")) break;
        this.take();
      }
      if (parenthesized) this.expectOperator(")");
      if (kind === "print" && parenthesized) {
        while (this.atOperator(",")) {
          this.take();
          values.push(this.expression());
        }
      }
      if (kind === "printf" && values.length === 0) this.fail("printf requires a format");
      if (
        !parenthesized &&
        values.some((value) => value.kind === "binary" && value.operator === ">")
      ) {
        this.fail("output redirection inside AWK is not supported");
      }
      return this.node({ kind, values });
    }
    if (this.atIdentifier("if")) {
      this.take();
      this.expectOperator("(");
      const condition = this.expression();
      this.expectOperator(")");
      while (this.at("newline")) this.take();
      const consequent = this.statementBody();
      const beforeElse = this.index;
      while (this.at("newline")) this.take();
      let alternate: readonly Statement[] = [];
      if (this.atIdentifier("else")) {
        this.take();
        while (this.at("newline")) this.take();
        alternate = this.statementBody();
      } else this.index = beforeElse;
      return this.node({ kind: "if", condition, consequent, alternate });
    }
    if (this.atIdentifier("while")) {
      this.take();
      this.expectOperator("(");
      const condition = this.expression();
      this.expectOperator(")");
      while (this.at("newline")) this.take();
      return this.node({
        kind: "while",
        condition,
        body: this.loopBody(),
      });
    }
    if (this.atIdentifier("do")) {
      this.take();
      while (this.at("newline")) this.take();
      const body = this.loopBody();
      while (this.at("newline")) this.take();
      if (!this.atIdentifier("while")) this.fail("do requires while");
      this.take();
      this.expectOperator("(");
      const condition = this.expression();
      this.expectOperator(")");
      return this.node({ kind: "do", body, condition });
    }
    if (this.atIdentifier("for")) {
      this.take();
      this.expectOperator("(");
      if (this.at("identifier") && this.nextIsIdentifier("in")) {
        const variable = this.take().value;
        this.take();
        if (!this.at("identifier")) this.fail("for-in requires an array name");
        const array = this.take().value;
        this.expectOperator(")");
        while (this.at("newline")) this.take();
        return this.node({
          kind: "for-in",
          variable,
          array,
          body: this.loopBody(),
        });
      }
      const initialize = this.atOperator(";") ? undefined : this.expression();
      this.expectOperator(";");
      const condition = this.atOperator(";") ? undefined : this.expression();
      this.expectOperator(";");
      const update = this.atOperator(")") ? undefined : this.expression();
      this.expectOperator(")");
      while (this.at("newline")) this.take();
      return this.node({
        kind: "for",
        ...(initialize === undefined ? {} : { initialize }),
        ...(condition === undefined ? {} : { condition }),
        ...(update === undefined ? {} : { update }),
        body: this.loopBody(),
      });
    }
    if (this.atIdentifier("delete")) {
      this.take();
      const target = this.primary();
      if (target.kind !== "array") this.fail("delete requires an array element");
      return this.node({ kind: "delete", target });
    }
    if (this.atIdentifier("break") || this.atIdentifier("continue")) {
      const token = this.take();
      const kind = token.value as "break" | "continue";
      if (this.loopDepth === 0) this.fail(`${kind} is not inside a loop`, token);
      return this.node({ kind });
    }
    if (this.atIdentifier("next")) {
      this.take();
      return this.node({ kind: "next" });
    }
    if (this.atIdentifier("exit")) {
      this.take();
      const ended =
        this.atOperator("}") || this.atOperator(";") || this.at("newline") || this.at("eof");
      return this.node({
        kind: "exit",
        ...(ended ? {} : { status: this.expression() }),
      });
    }
    return this.node({ kind: "expression", expression: this.expression() });
  }

  private expression(): Expression {
    return this.assignment();
  }

  private assignment(): Expression {
    const left = this.conditional();
    if (
      !this.at("operator") ||
      !["=", "+=", "-=", "*=", "/=", "%=", "^="].includes(this.current().value)
    ) {
      return left;
    }
    if (left.kind !== "variable" && left.kind !== "field" && left.kind !== "array")
      this.fail("assignment target is not writable");
    const operator = this.take().value as AssignmentOperator;
    return this.node({
      kind: "assign",
      target: left,
      operator,
      value: this.assignment(),
    });
  }

  private conditional(): Expression {
    const condition = this.logicalOr();
    if (!this.atOperator("?")) return condition;
    this.take();
    const consequent = this.assignment();
    this.expectOperator(":");
    return this.node({
      kind: "conditional",
      condition,
      consequent,
      alternate: this.assignment(),
    });
  }

  private logicalOr(): Expression {
    let expression = this.logicalAnd();
    while (this.atOperator("||")) {
      this.take();
      expression = this.node({
        kind: "binary",
        operator: "||",
        left: expression,
        right: this.logicalAnd(),
      });
    }
    return expression;
  }

  private logicalAnd(): Expression {
    let expression = this.comparison();
    while (this.atOperator("&&")) {
      this.take();
      expression = this.node({
        kind: "binary",
        operator: "&&",
        left: expression,
        right: this.comparison(),
      });
    }
    return expression;
  }

  private comparison(): Expression {
    let expression = this.concatenation();
    while (
      this.at("operator") &&
      ["==", "!=", "<", "<=", ">", ">=", "~", "!~"].includes(this.current().value)
    ) {
      const operator = this.take().value as Extract<Expression, { kind: "binary" }>["operator"];
      expression = this.node({
        kind: "binary",
        operator,
        left: expression,
        right: this.concatenation(),
      });
    }
    if (this.atIdentifier("in")) {
      this.take();
      if (!this.at("identifier")) this.fail("in requires an array name");
      expression = this.node({
        kind: "in",
        key: expression,
        array: this.take().value,
      });
    }
    return expression;
  }

  private startsPrimary(): boolean {
    return (
      (this.at("number") ||
        this.at("string") ||
        this.at("identifier") ||
        this.at("regex") ||
        this.atOperator("(") ||
        this.atOperator("$")) &&
      !this.atIdentifier("in")
    );
  }

  private concatenation(): Expression {
    let expression = this.additive();
    while (this.startsPrimary()) {
      expression = this.node({
        kind: "binary",
        operator: "concat",
        left: expression,
        right: this.additive(),
      });
    }
    return expression;
  }

  private additive(): Expression {
    let expression = this.multiplicative();
    while (this.atOperator("+") || this.atOperator("-")) {
      const operator = this.take().value as "+" | "-";
      expression = this.node({
        kind: "binary",
        operator,
        left: expression,
        right: this.multiplicative(),
      });
    }
    return expression;
  }

  private multiplicative(): Expression {
    let expression = this.unary();
    while (this.atOperator("*") || this.atOperator("/") || this.atOperator("%")) {
      const operator = this.take().value as "*" | "/" | "%";
      expression = this.node({
        kind: "binary",
        operator,
        left: expression,
        right: this.unary(),
      });
    }
    return expression;
  }

  private unary(): Expression {
    if (this.atOperator("!") || this.atOperator("+") || this.atOperator("-")) {
      const operator = this.take().value as "!" | "+" | "-";
      return this.node({ kind: "unary", operator, operand: this.unary() });
    }
    if (this.atOperator("++") || this.atOperator("--")) {
      const delta = this.take().value === "++" ? 1 : -1;
      const target = this.unary();
      if (target.kind !== "variable" && target.kind !== "field" && target.kind !== "array")
        this.fail("update target is not writable");
      return this.node({ kind: "update", target, delta, prefix: true });
    }
    return this.power();
  }

  private power(): Expression {
    const expression = this.postfix();
    if (!this.atOperator("^")) return expression;
    this.take();
    return this.node({
      kind: "binary",
      operator: "^",
      left: expression,
      right: this.unary(),
    });
  }

  private postfix(): Expression {
    const expression = this.primary();
    if (!this.atOperator("++") && !this.atOperator("--")) return expression;
    if (
      expression.kind !== "variable" &&
      expression.kind !== "field" &&
      expression.kind !== "array"
    )
      this.fail("update target is not writable");
    const delta = this.take().value === "++" ? 1 : -1;
    return this.node({
      kind: "update",
      target: expression,
      delta,
      prefix: false,
    });
  }

  private primary(): Expression {
    const token = this.take();
    if (token.kind === "number") return this.node({ kind: "number", value: Number(token.value) });
    if (token.kind === "string") return this.node({ kind: "string", value: token.value });
    if (token.kind === "regex") {
      return this.node({
        kind: "regex",
        pattern: compilePosixRegex(token.value, "extended", AWK.name),
      });
    }
    if (token.kind === "identifier") {
      if (["function", "getline", "return"].includes(token.value)) {
        this.fail(`unsupported construct ${token.value}`, token);
      }
      if (this.atOperator("(")) {
        if (!BUILTINS.has(token.value)) this.fail(`unsupported function ${token.value}`, token);
        this.take();
        const arguments_: Expression[] = [];
        if (!this.atOperator(")")) {
          while (!this.atOperator(")")) {
            arguments_.push(this.expression());
            if (!this.atOperator(",")) break;
            this.take();
          }
        }
        this.expectOperator(")");
        return this.node({
          kind: "call",
          name: token.value,
          arguments: arguments_,
        });
      }
      if (token.value === "length")
        return this.node({ kind: "call", name: "length", arguments: [] });
      if (this.atOperator("[")) {
        this.take();
        const indices: Expression[] = [];
        do {
          indices.push(this.expression());
          if (!this.atOperator(",")) break;
          this.take();
        } while (!this.atOperator("]"));
        this.expectOperator("]");
        return this.node({ kind: "array", name: token.value, indices });
      }
      return this.node({ kind: "variable", name: token.value });
    }
    if (token.kind === "operator" && token.value === "(") {
      const values = [this.expression()];
      while (this.atOperator(",")) {
        this.take();
        values.push(this.expression());
      }
      this.expectOperator(")");
      if (values.length === 1) return values[0] as Expression;
      if (!this.atIdentifier("in")) this.fail("a parenthesized expression list requires in");
      return this.node({ kind: "tuple", values });
    }
    if (token.kind === "operator" && token.value === "$") {
      return this.node({ kind: "field", index: this.unary() });
    }
    this.fail("expected an expression", token);
  }
}

interface AwkString {
  readonly kind: "string";
  readonly value: string;
  /** Input-derived numeric strings carry AWK's strnum attribute. */
  readonly numeric: boolean;
}

type AwkValue = number | AwkString;

const stringValue = (value: string, numeric = false): AwkString => ({
  kind: "string",
  value,
  numeric,
});
const inputValue = (value: string): AwkString =>
  stringValue(
    value,
    value === "" || /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/u.test(value),
  );

function numericPrefix(value: string): number {
  const prefix = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(value)?.[0];
  return prefix === undefined ? 0 : Number(prefix);
}

function asNumber(value: AwkValue): number {
  if (typeof value === "number") return value;
  return numericPrefix(value.value);
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : value > 0 ? "inf" : "nan";
  if (Object.is(value, -0)) return "0";
  if (Number.isSafeInteger(value)) return String(value);
  return generalNumber(value, 6);
}

function asString(value: AwkValue): string {
  if (typeof value === "number") return numberText(value);
  return value.value;
}

function truth(value: AwkValue): boolean {
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  return value.numeric ? numericPrefix(value.value) !== 0 : value.value.length > 0;
}

function numericComparable(value: AwkValue): boolean {
  return typeof value === "number" || (value.kind === "string" && value.numeric);
}

function compare(left: AwkValue, right: AwkValue): number {
  if (numericComparable(left) && numericComparable(right)) return asNumber(left) - asNumber(right);
  return compareUtf8(asString(left), asString(right));
}

interface RuntimeState {
  readonly context: ShellCommandContext;
  readonly variables: Map<string, AwkValue>;
  readonly arrays: Map<string, Map<string, AwkValue>>;
  readonly regexCache: Map<string, PosixRegex>;
  readonly activeRanges: Set<Rule>;
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

function getVariable(state: RuntimeState, name: string): AwkValue {
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

function setVariable(state: RuntimeState, name: string, value: AwkValue): void {
  if (state.arrays.has(name)) throw new VfsError("EINVAL", `awk: ${name} is an array`);
  if (name === "NF" || name === "FILENAME")
    throw new VfsError("EINVAL", `awk: cannot assign to ${name}`);
  if (name === "NR") {
    state.nr = Math.trunc(asNumber(value));
    return;
  }
  if (name === "FNR") {
    state.fnr = Math.trunc(asNumber(value));
    return;
  }
  if (name === "RS" && asString(value) !== "\n") {
    throw new VfsError("ENOTSUP", "awk: record separators other than newline are unsupported");
  }
  if ((name === "OFMT" || name === "CONVFMT") && asString(value) !== "%.6g") {
    throw new VfsError("ENOTSUP", `awk: changing ${name} is unsupported`);
  }
  if (name === "FS") validateFieldSeparator(state, asString(value));
  state.variables.set(name, value);
}

function getArray(state: RuntimeState, name: string): Map<string, AwkValue> {
  if (state.variables.has(name)) throw new VfsError("EINVAL", `awk: ${name} is not an array`);
  let array = state.arrays.get(name);
  if (array === undefined) {
    array = new Map();
    state.arrays.set(name, array);
  }
  return array;
}

function arrayKey(indices: readonly Expression[], state: RuntimeState): string {
  const separator = asString(getVariable(state, "SUBSEP"));
  return indices.map((index) => asString(evaluate(index, state))).join(separator);
}

function putArray(state: RuntimeState, name: string, key: string, value: AwkValue): void {
  const array = getArray(state, name);
  const previous = array.get(key);
  if (!array.has(key)) {
    if (state.arrayEntries >= state.context.budget.limits.maxBufferedRecords) {
      throw new VfsError("E2BIG", "awk: array entry limit exceeded");
    }
    state.arrayEntries += 1;
  }
  const previousBytes =
    previous === undefined
      ? 0
      : AWK_ENCODER.encode(key).byteLength + AWK_ENCODER.encode(asString(previous)).byteLength;
  const nextBytes =
    AWK_ENCODER.encode(key).byteLength + AWK_ENCODER.encode(asString(value)).byteLength;
  resizeArrayBuffer(state, state.arrayBytes + nextBytes - previousBytes);
  array.set(key, value);
}

function resizeArrayBuffer(state: RuntimeState, bytes: number): void {
  state.arrayRelease();
  state.arrayRelease = () => undefined;
  state.arrayBytes = bytes;
  state.arrayRelease = state.context.budget.buffered(bytes);
}

function clearArray(state: RuntimeState, name: string): Map<string, AwkValue> {
  const array = getArray(state, name);
  let releasedBytes = 0;
  for (const [key, value] of array) {
    releasedBytes +=
      AWK_ENCODER.encode(key).byteLength + AWK_ENCODER.encode(asString(value)).byteLength;
  }
  resizeArrayBuffer(state, state.arrayBytes - releasedBytes);
  state.arrayEntries -= array.size;
  array.clear();
  return array;
}

function fieldIndex(value: AwkValue): number {
  const index = Math.trunc(asNumber(value));
  if (!Number.isSafeInteger(index) || index < 0)
    throw new VfsError("EINVAL", "awk: invalid field index");
  return index;
}

function getField(state: RuntimeState, index: number): AwkValue {
  if (index === 0) return inputValue(state.record);
  ensureFields(state);
  return state.fields[index - 1] ?? inputValue("");
}

function setField(state: RuntimeState, index: number, value: AwkValue): void {
  if (index === 0) {
    state.record = asString(value);
    state.fieldSeparator = asString(getVariable(state, "FS"));
    state.fieldsValid = false;
    return;
  }
  if (index > state.context.budget.limits.maxBufferedRecords)
    throw new VfsError("E2BIG", "awk: field limit exceeded");
  ensureFields(state);
  while (state.fields.length < index) state.fields.push(inputValue(""));
  state.fields[index - 1] = stringValue(asString(value), numericComparable(value));
  const separator = asString(getVariable(state, "OFS"));
  let characters = Math.max(0, state.fields.length - 1) * separator.length;
  for (const field of state.fields) {
    characters += field.value.length;
    if (characters > state.context.budget.limits.maxExpansionChars)
      throw new VfsError("E2BIG", "awk: rebuilt record exceeds the expansion limit");
  }
  state.record = state.fields.map((field) => field.value).join(separator);
}

function compiledRegex(state: RuntimeState, source: string): PosixRegex {
  const cached = state.regexCache.get(source);
  if (cached !== undefined) return cached;
  const pattern = compilePosixRegex(source, "extended", AWK.name);
  state.regexCache.set(source, pattern);
  return pattern;
}

function separatorRegex(state: RuntimeState, separator: string): PosixRegex {
  const pattern = compiledRegex(state, separator);
  if (pattern.test("")) throw new VfsError("EINVAL", "awk: an empty-matching FS is unsupported");
  return pattern;
}

function validateFieldSeparator(state: RuntimeState, separator: string): void {
  if (separator === "") throw new VfsError("EINVAL", "awk: empty FS is unsupported");
  if (separator !== " " && [...separator].length > 1) separatorRegex(state, separator);
}

function splitText(state: RuntimeState, text: string, separator: string): AwkString[] {
  const checkCount = (count: number): void => {
    if (count > state.context.budget.limits.maxBufferedRecords)
      throw new VfsError("E2BIG", "awk: field limit exceeded");
  };
  if (text === "") return [];
  if (separator === " ") {
    const trimmed = text.replace(/^[ \t\n]+|[ \t\n]+$/gu, "");
    if (trimmed.length >= state.context.budget.limits.maxBufferedRecords) {
      let count = 0;
      const fields = /[^ \t\n]+/gu;
      while (fields.exec(trimmed) !== null) {
        count += 1;
        checkCount(count);
      }
    }
    return trimmed === "" ? [] : trimmed.split(/[ \t\n]+/u).map((value) => inputValue(value));
  }
  if ([...separator].length === 1) {
    if (text.length + 1 > state.context.budget.limits.maxBufferedRecords) {
      let count = 1;
      let offset = 0;
      for (;;) {
        const found = text.indexOf(separator, offset);
        if (found < 0) break;
        count += 1;
        checkCount(count);
        offset = found + separator.length;
      }
    }
    return text.split(separator).map((value) => inputValue(value));
  }
  const pattern = separatorRegex(state, separator);
  const fields: AwkString[] = [];
  let offset = 0;
  for (;;) {
    const match = pattern.exec(text, offset);
    if (match === undefined) break;
    checkCount(fields.length + 1);
    fields.push(inputValue(text.slice(offset, match.index)));
    offset = match.end;
  }
  checkCount(fields.length + 1);
  fields.push(inputValue(text.slice(offset)));
  return fields;
}

function splitRecord(state: RuntimeState): void {
  state.fields = splitText(state, state.record, state.fieldSeparator);
  state.fieldsValid = true;
}

function ensureFields(state: RuntimeState): void {
  if (!state.fieldsValid) splitRecord(state);
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

function evaluateSpecialCall(
  expression: Extract<Expression, { kind: "call" }>,
  state: RuntimeState,
): AwkValue | undefined {
  const arguments_ = expression.arguments;
  if (
    expression.name === "length" &&
    arguments_.length === 1 &&
    arguments_[0]?.kind === "variable" &&
    state.arrays.has(arguments_[0].name)
  ) {
    return getArray(state, arguments_[0].name).size;
  }
  if (expression.name === "match") {
    if (arguments_.length !== 2) throw new VfsError("EINVAL", "awk: match expects two arguments");
    const source = asString(evaluate(arguments_[0] as Expression, state));
    const found = expressionRegex(arguments_[1] as Expression, state).exec(source);
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
  if (expression.name === "split") {
    if (arguments_.length < 2 || arguments_.length > 3)
      throw new VfsError("EINVAL", "awk: split expects two or three arguments");
    const target = arguments_[1];
    if (target?.kind !== "variable")
      throw new VfsError("EINVAL", "awk: split requires an array name as its second argument");
    const source = asString(evaluate(arguments_[0] as Expression, state));
    const separator =
      arguments_[2] === undefined
        ? asString(getVariable(state, "FS"))
        : arguments_[2].kind === "regex"
          ? undefined
          : asString(evaluate(arguments_[2], state));
    let fields: AwkString[];
    if (separator !== undefined) {
      validateFieldSeparator(state, separator);
      fields = splitText(state, source, separator);
    } else {
      const pattern = expressionRegex(arguments_[2] as Expression, state);
      if (pattern.test(""))
        throw new VfsError("EINVAL", "awk: an empty-matching split separator is unsupported");
      fields = [];
      if (source !== "") {
        let offset = 0;
        for (;;) {
          const found = pattern.exec(source, offset);
          if (found === undefined) break;
          if (fields.length >= state.context.budget.limits.maxBufferedRecords)
            throw new VfsError("E2BIG", "awk: field limit exceeded");
          fields.push(inputValue(source.slice(offset, found.index)));
          offset = found.end;
        }
        if (fields.length >= state.context.budget.limits.maxBufferedRecords)
          throw new VfsError("E2BIG", "awk: field limit exceeded");
        fields.push(inputValue(source.slice(offset)));
      }
    }
    clearArray(state, target.name);
    for (let index = 0; index < fields.length; index += 1) {
      putArray(state, target.name, String(index + 1), fields[index] ?? inputValue(""));
    }
    return fields.length;
  }
  if (expression.name === "sub" || expression.name === "gsub") {
    if (arguments_.length < 2 || arguments_.length > 3)
      throw new VfsError("EINVAL", `awk: ${expression.name} expects two or three arguments`);
    const pattern = expressionRegex(arguments_[0] as Expression, state);
    const replacement = asString(evaluate(arguments_[1] as Expression, state));
    const target = arguments_[2];
    if (
      target !== undefined &&
      target.kind !== "variable" &&
      target.kind !== "field" &&
      target.kind !== "array"
    ) {
      throw new VfsError("EINVAL", `awk: ${expression.name} target is not writable`);
    }
    const resolved = target === undefined ? undefined : resolveLValue(target, state);
    const original =
      resolved === undefined ? state.record : asString(readResolved(resolved, state));
    const result = substitute(original, pattern, replacement, expression.name === "gsub", state);
    if (resolved === undefined) setField(state, 0, stringValue(result.value));
    else writeResolved(resolved, stringValue(result.value), state);
    return result.count;
  }
  return undefined;
}

function callBuiltin(name: string, arguments_: readonly AwkValue[], state: RuntimeState): AwkValue {
  const argument = (index: number, fallback: AwkValue = inputValue("")): AwkValue =>
    arguments_[index] ?? fallback;
  if (name === "length") {
    if (arguments_.length > 1)
      throw new VfsError("EINVAL", "awk: length accepts at most one argument");
    return [...asString(argument(0, inputValue(state.record)))].length;
  }
  if (name === "substr") {
    if (arguments_.length < 2 || arguments_.length > 3)
      throw new VfsError("EINVAL", "awk: substr expects two or three arguments");
    const points = [...asString(argument(0))];
    const start = Math.max(1, Math.trunc(asNumber(argument(1)))) - 1;
    const length =
      arguments_[2] === undefined
        ? points.length
        : Math.max(0, Math.trunc(asNumber(arguments_[2])));
    return stringValue(points.slice(start, start + length).join(""));
  }
  if (name === "index") {
    if (arguments_.length !== 2) throw new VfsError("EINVAL", "awk: index expects two arguments");
    const found = asString(argument(0)).indexOf(asString(argument(1)));
    return found < 0 ? 0 : [...asString(argument(0)).slice(0, found)].length + 1;
  }
  if (name === "tolower" || name === "toupper") {
    if (arguments_.length !== 1) throw new VfsError("EINVAL", `awk: ${name} expects one argument`);
    const value = asString(argument(0));
    return stringValue(
      name === "tolower"
        ? value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32))
        : value.replace(/[a-z]/gu, (character) =>
            String.fromCharCode(character.charCodeAt(0) - 32),
          ),
    );
  }
  if (name === "int") {
    if (arguments_.length !== 1) throw new VfsError("EINVAL", "awk: int expects one argument");
    return Math.trunc(asNumber(argument(0)));
  }
  if (name === "sprintf") {
    if (arguments_.length === 0) throw new VfsError("EINVAL", "awk: sprintf requires a format");
    const formatted = formatAwk(
      asString(argument(0)),
      arguments_.slice(1),
      state.context.budget.limits.maxExpansionChars,
    );
    state.context.budget.expansionWork(formatted.length);
    return stringValue(formatted);
  }
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

function evaluate(expression: Expression, state: RuntimeState): AwkValue {
  state.context.budget.step();
  if (expression.kind === "number") return expression.value;
  if (expression.kind === "string") return stringValue(expression.value);
  if (expression.kind === "regex") return expression.pattern.test(state.record) ? 1 : 0;
  if (expression.kind === "variable") return getVariable(state, expression.name);
  if (expression.kind === "field")
    return getField(state, fieldIndex(evaluate(expression.index, state)));
  if (expression.kind === "array") return readLValue(expression, state);
  if (expression.kind === "in") {
    const key =
      expression.key.kind === "tuple"
        ? expression.key.values
            .map((value) => asString(evaluate(value, state)))
            .join(asString(getVariable(state, "SUBSEP")))
        : asString(evaluate(expression.key, state));
    return getArray(state, expression.array).has(key) ? 1 : 0;
  }
  if (expression.kind === "tuple")
    throw new VfsError("EINVAL", "awk: expression list is only valid with in");
  if (expression.kind === "call") {
    const special = evaluateSpecialCall(expression, state);
    if (special !== undefined) return special;
    return callBuiltin(
      expression.name,
      expression.arguments.map((argument) => evaluate(argument, state)),
      state,
    );
  }
  if (expression.kind === "unary") {
    const value = evaluate(expression.operand, state);
    if (expression.operator === "!") return truth(value) ? 0 : 1;
    return expression.operator === "+" ? asNumber(value) : -asNumber(value);
  }
  if (expression.kind === "conditional") {
    return truth(evaluate(expression.condition, state))
      ? evaluate(expression.consequent, state)
      : evaluate(expression.alternate, state);
  }
  if (expression.kind === "assign") {
    const target = resolveLValue(expression.target, state);
    const right = evaluate(expression.value, state);
    const value =
      expression.operator === "="
        ? right
        : arithmetic(expression.operator[0] ?? "+", readResolved(target, state), right);
    writeResolved(target, value, state);
    return value;
  }
  if (expression.kind === "update") {
    const target = resolveLValue(expression.target, state);
    const previous = asNumber(readResolved(target, state));
    const value = previous + expression.delta;
    writeResolved(target, value, state);
    return expression.prefix ? value : previous;
  }
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
  const left = evaluate(expression.left, state);
  if (expression.operator === "~" || expression.operator === "!~") {
    let pattern: PosixRegex;
    if (expression.right.kind === "regex") {
      state.context.budget.step();
      pattern = expression.right.pattern;
    } else pattern = dynamicRegex(evaluate(expression.right, state), state);
    const matched = pattern.test(asString(left));
    return expression.operator === "~" ? (matched ? 1 : 0) : matched ? 0 : 1;
  }
  const right = evaluate(expression.right, state);
  if (["+", "-", "*", "/", "%", "^"].includes(expression.operator))
    return arithmetic(expression.operator, left, right);
  if (expression.operator === "concat") return stringValue(`${asString(left)}${asString(right)}`);
  const order = compare(left, right);
  if (expression.operator === "==") return order === 0 ? 1 : 0;
  if (expression.operator === "!=") return order !== 0 ? 1 : 0;
  if (expression.operator === "<") return order < 0 ? 1 : 0;
  if (expression.operator === "<=") return order <= 0 ? 1 : 0;
  if (expression.operator === ">") return order > 0 ? 1 : 0;
  return order >= 0 ? 1 : 0;
}

function pad(value: string, width: number, left: boolean, zero = false): string {
  const missing = Math.max(0, width - value.length);
  if (missing === 0) return value;
  const padding = (zero ? "0" : " ").repeat(missing);
  if (left) return value + padding;
  if (zero && /^[+-]/u.test(value)) return `${value[0]}${padding}${value.slice(1)}`;
  return padding + value;
}

function normalizeExponent(value: string): string {
  return value.replace(/e([+-])(\d)$/u, "e$10$2");
}

function generalNumber(value: number, precision: number): string {
  return normalizeExponent(
    value.toPrecision(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))(?=e|$)/u, "$1"),
  );
}

/** The common AWK printf core: bounded conversions, literal widths, no host locale. */
function formatAwk(format: string, values: readonly AwkValue[], maximumCharacters: number): string {
  let output = "";
  let valueIndex = 0;
  const append = (value: string): void => {
    if (output.length + value.length > maximumCharacters) {
      throw new VfsError("E2BIG", "awk: printf output exceeds the execution limit");
    }
    output += value;
  };
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index] ?? "";
    if (character !== "%") {
      append(character);
      continue;
    }
    if (format[index + 1] === "%") {
      append("%");
      index += 1;
      continue;
    }
    const conversion = /^([-+ 0]*)([0-9]*)(?:\.([0-9]+))?([scdiufegEGoxX])/u.exec(
      format.slice(index + 1),
    );
    if (conversion === null)
      throw new VfsError(
        "EINVAL",
        `awk: unsupported printf conversion %${format[index + 1] ?? ""}`,
      );
    index += conversion[0].length;
    const flags = conversion[1] ?? "";
    const width = Number(conversion[2] ?? "0");
    const precision = conversion[3] === undefined ? undefined : Number(conversion[3]);
    if (width > maximumCharacters || (precision ?? 0) > maximumCharacters) {
      throw new VfsError("E2BIG", "awk: printf field exceeds the execution limit");
    }
    const specifier = conversion[4] ?? "s";
    const value = values[valueIndex++] ?? inputValue("");
    let rendered: string;
    if (specifier === "s") {
      const points = [...asString(value)];
      rendered = precision === undefined ? points.join("") : points.slice(0, precision).join("");
    } else if (specifier === "c") {
      rendered =
        typeof value === "number"
          ? String.fromCodePoint(Math.trunc(value))
          : ([...asString(value)][0] ?? "");
    } else if (
      specifier === "d" ||
      specifier === "i" ||
      specifier === "u" ||
      specifier === "o" ||
      specifier === "x" ||
      specifier === "X"
    ) {
      let integer = Math.trunc(asNumber(value));
      if (specifier === "u") integer >>>= 0;
      const radix = specifier === "o" ? 8 : specifier === "x" || specifier === "X" ? 16 : 10;
      rendered = Math.abs(integer).toString(radix);
      if (specifier === "X") rendered = rendered.toUpperCase();
      if (precision !== undefined) rendered = rendered.padStart(precision, "0");
      if (integer < 0) rendered = `-${rendered}`;
      else if (flags.includes("+")) rendered = `+${rendered}`;
      else if (flags.includes(" ")) rendered = ` ${rendered}`;
    } else {
      const number = asNumber(value);
      const digits =
        specifier === "g" || specifier === "G" ? Math.max(1, precision ?? 6) : (precision ?? 6);
      if (digits > 100) {
        throw new VfsError("E2BIG", "awk: floating-point precision exceeds the execution limit");
      }
      if (specifier === "f") rendered = number.toFixed(digits);
      else if (specifier === "e" || specifier === "E")
        rendered = normalizeExponent(number.toExponential(digits));
      else rendered = generalNumber(number, digits);
      if (specifier === "E" || specifier === "G") rendered = rendered.toUpperCase();
      if (number >= 0 && flags.includes("+")) rendered = `+${rendered}`;
      else if (number >= 0 && flags.includes(" ")) rendered = ` ${rendered}`;
    }
    append(pad(rendered, width, flags.includes("-"), flags.includes("0")));
  }
  return output;
}

type Control =
  | { readonly kind: "none" }
  | { readonly kind: "break" }
  | { readonly kind: "continue" }
  | { readonly kind: "next" }
  | { readonly kind: "exit" };
const NO_CONTROL: Control = { kind: "none" };

async function executeStatements(
  statements: readonly Statement[],
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  for (const statement of statements) {
    state.context.budget.step();
    if (statement.kind === "print") {
      const values =
        statement.values.length === 0
          ? [inputValue(state.record)]
          : statement.values.map((value) => evaluate(value, state));
      await output.write(
        `${values.map(asString).join(asString(getVariable(state, "OFS")))}${asString(getVariable(state, "ORS"))}`,
      );
      continue;
    }
    if (statement.kind === "printf") {
      const values = statement.values.map((value) => evaluate(value, state));
      await output.write(
        formatAwk(
          asString(values[0] ?? inputValue("")),
          values.slice(1),
          state.context.budget.limits.maxStdoutBytes,
        ),
      );
      continue;
    }
    if (statement.kind === "expression") {
      evaluate(statement.expression, state);
      continue;
    }
    if (statement.kind === "if") {
      const branch = truth(evaluate(statement.condition, state))
        ? statement.consequent
        : statement.alternate;
      const control = await executeStatements(branch, state, output);
      if (control.kind !== "none") return control;
      continue;
    }
    if (statement.kind === "while" || statement.kind === "do") {
      let first = true;
      while (
        statement.kind === "do"
          ? first || truth(evaluate(statement.condition, state))
          : truth(evaluate(statement.condition, state))
      ) {
        first = false;
        state.context.budget.loop();
        const control = await executeStatements(statement.body, state, output);
        if (control.kind === "break") break;
        if (control.kind !== "none" && control.kind !== "continue") return control;
      }
      continue;
    }
    if (statement.kind === "for") {
      if (statement.initialize !== undefined) evaluate(statement.initialize, state);
      while (statement.condition === undefined || truth(evaluate(statement.condition, state))) {
        state.context.budget.loop();
        const control = await executeStatements(statement.body, state, output);
        if (control.kind === "break") break;
        if (control.kind !== "none" && control.kind !== "continue") return control;
        if (statement.update !== undefined) evaluate(statement.update, state);
      }
      continue;
    }
    if (statement.kind === "for-in") {
      const keys = [...getArray(state, statement.array).keys()];
      for (const key of keys) {
        state.context.budget.loop();
        setVariable(state, statement.variable, inputValue(key));
        const control = await executeStatements(statement.body, state, output);
        if (control.kind === "break") break;
        if (control.kind !== "none" && control.kind !== "continue") return control;
      }
      continue;
    }
    if (statement.kind === "delete") {
      const array = getArray(state, statement.target.name);
      const key = arrayKey(statement.target.indices, state);
      const value = array.get(key);
      if (value !== undefined) {
        resizeArrayBuffer(
          state,
          state.arrayBytes -
            AWK_ENCODER.encode(key).byteLength -
            AWK_ENCODER.encode(asString(value)).byteLength,
        );
        array.delete(key);
        state.arrayEntries -= 1;
      }
      continue;
    }
    if (statement.kind === "break" || statement.kind === "continue")
      return { kind: statement.kind };
    if (statement.kind === "next") return { kind: "next" };
    if (statement.status !== undefined)
      state.exitStatus = Math.trunc(asNumber(evaluate(statement.status, state))) & 0xff;
    return { kind: "exit" };
  }
  return NO_CONTROL;
}

async function executeRules(
  rules: readonly Rule[],
  phase: Rule["phase"],
  state: RuntimeState,
  output: BufferedTextWriter,
): Promise<Control> {
  for (const rule of rules) {
    if (rule.phase !== phase) continue;
    if (rule.rangeEnd !== undefined) {
      const active = state.activeRanges.has(rule);
      if (!active && (rule.pattern === undefined || !truth(evaluate(rule.pattern, state))))
        continue;
      if (!active) state.activeRanges.add(rule);
      if (truth(evaluate(rule.rangeEnd, state))) state.activeRanges.delete(rule);
    } else if (rule.pattern !== undefined && !truth(evaluate(rule.pattern, state))) continue;
    if (rule.action === undefined) {
      await output.write(`${state.record}${asString(getVariable(state, "ORS"))}`);
      continue;
    }
    const control = await executeStatements(rule.action, state, output);
    if (control.kind === "break" || control.kind === "continue") {
      throw new VfsError("EINVAL", `awk: ${control.kind} is not inside a loop`);
    }
    if (control.kind !== "none") return control;
  }
  return NO_CONTROL;
}

function assignment(value: string): readonly [string, AwkValue] {
  const parsed = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(value);
  if (parsed === null) throw appletUsageError(AWK, `invalid assignment: ${value}`);
  const name = parsed[1] ?? "";
  if (["NR", "FNR", "NF", "FILENAME"].includes(name)) {
    throw appletUsageError(AWK, `cannot initialize ${name}`);
  }
  return [name, inputValue(parsed[2] ?? "")];
}

/**
 * Runs the bounded, streaming AWK profile.
 *
 * The program is compiled before an input stream is opened, so malformed or
 * unsupported syntax cannot consume stdin or expose a partial output. Every
 * record and expression spends the caller's ordinary shell budget, and the
 * shared line reader supplies UTF-8, cancellation, I/O, and record bounds.
 */
export const awkCommand = /* @__PURE__ */ defineApplet(AWK, async (context, argv, fds) => {
  const parsed = parseAppletOptions(AWK, argv);
  const programFiles = parsed.options
    .filter((option) => option.name === "program-file" && "argument" in option)
    .map((option) => ("argument" in option ? option.argument : ""));
  const operands = [...parsed.operands];
  let source: string;
  if (programFiles.length === 0) {
    const inline = operands.shift();
    if (inline === undefined) throw appletUsageError(AWK, "missing program");
    source = inline;
  } else {
    const chunks: string[] = [];
    let bytes = 0;
    for (const path of programFiles) {
      const separatorBytes = chunks.length === 0 ? 0 : 1;
      if (bytes + separatorBytes > context.budget.limits.maxScriptBytes) {
        throw new VfsError("E2BIG", "awk: program byte limit exceeded", path);
      }
      const lease = await readFileText(
        context,
        path,
        context.budget.limits.maxScriptBytes - bytes - separatorBytes,
      );
      try {
        if (lease.value.includes("\0")) {
          throw new VfsError("EINVAL", "awk: program file contains a NUL byte", path);
        }
        bytes += AWK_ENCODER.encode(lease.value).byteLength + separatorBytes;
        chunks.push(lease.value);
      } finally {
        lease.release();
      }
    }
    source = chunks.join("\n");
  }
  if (source.includes("\0")) throw new VfsError("EINVAL", "awk: program contains a NUL byte");
  const paths = operands;
  const operandAssignment = paths.find((path) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(path));
  if (operandAssignment !== undefined) {
    throw appletUsageError(AWK, "assignments after the program are unsupported; use -v");
  }
  if (AWK_ENCODER.encode(source).byteLength > context.budget.limits.maxScriptBytes) {
    throw new VfsError("E2BIG", "awk: program byte limit exceeded");
  }
  const rules = new Parser(
    tokenize(source),
    context.budget.limits.maxAstNodes,
    context.budget.limits.maxNestingDepth,
  ).parse();
  const variables = new Map<string, AwkValue>([
    ["FS", stringValue(" ")],
    ["OFS", stringValue(" ")],
    ["ORS", stringValue("\n")],
    ["RS", stringValue("\n")],
    ["OFMT", stringValue("%.6g")],
    ["CONVFMT", stringValue("%.6g")],
    ["SUBSEP", stringValue("\x1c")],
    ["RSTART", 0],
    ["RLENGTH", -1],
  ]);
  for (const option of parsed.options) {
    if (!("argument" in option)) continue;
    if (option.name === "field-separator") variables.set("FS", stringValue(option.argument));
    else if (option.name === "assign") {
      const [name, value] = assignment(option.argument);
      variables.set(name, value);
    }
  }

  const state: RuntimeState = {
    context,
    variables,
    arrays: new Map(),
    regexCache: new Map(),
    activeRanges: new Set(),
    arrayEntries: 0,
    arrayBytes: 0,
    arrayRelease: () => undefined,
    record: "",
    fields: [],
    fieldsValid: false,
    fieldSeparator: " ",
    nr: 0,
    fnr: 0,
    filename: "",
    exitStatus: 0,
  };
  if (asString(getVariable(state, "RS")) !== "\n") {
    throw new VfsError("ENOTSUP", "awk: record separators other than newline are unsupported");
  }
  if (
    asString(getVariable(state, "OFMT")) !== "%.6g" ||
    asString(getVariable(state, "CONVFMT")) !== "%.6g"
  ) {
    throw new VfsError("ENOTSUP", "awk: changing OFMT or CONVFMT is unsupported");
  }
  validateFieldSeparator(state, asString(getVariable(state, "FS")));
  const output = new BufferedTextWriter(context, fds[1]);
  const needsInput = rules.some((rule) => rule.phase !== "begin");
  let exiting = false;
  try {
    const begin = await executeRules(rules, "begin", state, output);
    if (begin.kind === "next") throw new VfsError("EINVAL", "awk: next is not valid in BEGIN");
    exiting = begin.kind === "exit";
    if (!exiting && needsInput) {
      for await (const input of inputStreams(context, paths, fds[0])) {
        state.filename = input.name;
        state.fnr = 0;
        for await (const line of readTextLines(context, input.stream, input.name)) {
          state.record = line.endsWith("\n") ? line.slice(0, -1) : line;
          state.fields = [];
          state.fieldsValid = false;
          state.fieldSeparator = asString(getVariable(state, "FS"));
          state.nr += 1;
          state.fnr += 1;
          const control = await executeRules(rules, "record", state, output);
          if (control.kind === "exit") {
            exiting = true;
            break;
          }
        }
        if (exiting) break;
      }
    }
    const end = await executeRules(rules, "end", state, output);
    if (end.kind === "next") throw new VfsError("EINVAL", "awk: next is not valid in END");
    await output.flush();
    return state.exitStatus;
  } finally {
    output.abort();
    state.arrayRelease();
  }
});
