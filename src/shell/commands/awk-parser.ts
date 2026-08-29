import { compilePosixRegex } from "../../core/posix-regex.js";
import {
  ADDITIVE_OPERATORS,
  ASSIGNMENT_OPERATORS,
  AWK_BUILTINS,
  type AwkRule,
  COMPARISON_OPERATORS,
  type Expression,
  LOOP_CONTROL_KINDS,
  MULTIPLICATIVE_OPERATORS,
  PRINT_KINDS,
  type Statement,
  UNARY_OPERATORS,
} from "./awk-ast.js";
import type { AwkToken } from "./awk-lexer.js";
import { AwkParserCursor } from "./awk-parser-cursor.js";

class Parser extends AwkParserCursor {
  private loopDepth = 0;

  parse(): AwkRule[] {
    const rules: AwkRule[] = [];
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

  private separators(): void {
    while (this.at("newline") || this.atOperator(";")) this.take();
  }

  private rule(): AwkRule {
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
    return this.atOperator("{") ? this.block() : [this.statement()];
  }

  private loopBody(): Statement[] {
    this.loopDepth += 1;
    try {
      return this.statementBody();
    } finally {
      this.loopDepth -= 1;
    }
  }

  private consumeNewlines(): void {
    while (this.at("newline")) this.take();
  }

  private statementEnded(): boolean {
    return this.atOperator("}") || this.atOperator(";") || this.at("newline") || this.at("eof");
  }

  private printStatement(): Statement {
    const kind = this.takeOneOf("identifier", PRINT_KINDS);
    const parenthesized = this.atOperator("(");
    if (parenthesized) this.take();
    const values: Expression[] = [];
    while (!(parenthesized ? this.atOperator(")") : this.statementEnded())) {
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

  private ifStatement(): Statement {
    this.take();
    this.expectOperator("(");
    const condition = this.expression();
    this.expectOperator(")");
    this.consumeNewlines();
    const consequent = this.statementBody();
    const beforeElse = this.index;
    this.consumeNewlines();
    if (!this.atIdentifier("else")) {
      this.index = beforeElse;
      return this.node({ kind: "if", condition, consequent, alternate: [] });
    }
    this.take();
    this.consumeNewlines();
    return this.node({ kind: "if", condition, consequent, alternate: this.statementBody() });
  }

  private whileStatement(): Statement {
    this.take();
    this.expectOperator("(");
    const condition = this.expression();
    this.expectOperator(")");
    this.consumeNewlines();
    return this.node({ kind: "while", condition, body: this.loopBody() });
  }

  private doStatement(): Statement {
    this.take();
    this.consumeNewlines();
    const body = this.loopBody();
    this.consumeNewlines();
    if (!this.atIdentifier("while")) this.fail("do requires while");
    this.take();
    this.expectOperator("(");
    const condition = this.expression();
    this.expectOperator(")");
    return this.node({ kind: "do", body, condition });
  }

  private forInStatement(): Statement {
    const variable = this.take().value;
    this.take();
    if (!this.at("identifier")) this.fail("for-in requires an array name");
    const array = this.take().value;
    this.expectOperator(")");
    this.consumeNewlines();
    return this.node({ kind: "for-in", variable, array, body: this.loopBody() });
  }

  private forStatement(): Statement {
    this.take();
    this.expectOperator("(");
    if (this.at("identifier") && this.nextIsIdentifier("in")) return this.forInStatement();
    const initialize = this.atOperator(";") ? undefined : this.expression();
    this.expectOperator(";");
    const condition = this.atOperator(";") ? undefined : this.expression();
    this.expectOperator(";");
    const update = this.atOperator(")") ? undefined : this.expression();
    this.expectOperator(")");
    this.consumeNewlines();
    return this.node({
      kind: "for",
      ...(initialize === undefined ? {} : { initialize }),
      ...(condition === undefined ? {} : { condition }),
      ...(update === undefined ? {} : { update }),
      body: this.loopBody(),
    });
  }

  private deleteStatement(): Statement {
    this.take();
    const target = this.primary();
    if (target.kind !== "array") this.fail("delete requires an array element");
    return this.node({ kind: "delete", target });
  }

  private loopControlStatement(): Statement {
    const token = this.current();
    const kind = this.takeOneOf("identifier", LOOP_CONTROL_KINDS);
    if (this.loopDepth === 0) this.fail(`${kind} is not inside a loop`, token);
    return this.node({ kind });
  }

  private exitStatement(): Statement {
    this.take();
    return this.node({
      kind: "exit",
      ...(this.statementEnded() ? {} : { status: this.expression() }),
    });
  }

  private statement(): Statement {
    if (this.atIdentifier("print") || this.atIdentifier("printf")) return this.printStatement();
    if (this.atIdentifier("if")) return this.ifStatement();
    if (this.atIdentifier("while")) return this.whileStatement();
    if (this.atIdentifier("do")) return this.doStatement();
    if (this.atIdentifier("for")) return this.forStatement();
    if (this.atIdentifier("delete")) return this.deleteStatement();
    if (this.atIdentifier("break") || this.atIdentifier("continue"))
      return this.loopControlStatement();
    if (this.atIdentifier("next")) {
      this.take();
      return this.node({ kind: "next" });
    }
    if (this.atIdentifier("exit")) return this.exitStatement();
    return this.node({ kind: "expression", expression: this.expression() });
  }

  private expression(): Expression {
    return this.assignment();
  }

  private assignment(): Expression {
    const left = this.conditional();
    if (!this.atOneOf("operator", ASSIGNMENT_OPERATORS)) return left;
    if (left.kind !== "variable" && left.kind !== "field" && left.kind !== "array") {
      this.fail("assignment target is not writable");
    }
    const operator = this.takeOneOf("operator", ASSIGNMENT_OPERATORS);
    return this.node({ kind: "assign", target: left, operator, value: this.assignment() });
  }

  private conditional(): Expression {
    const condition = this.logicalOr();
    if (!this.atOperator("?")) return condition;
    this.take();
    const consequent = this.assignment();
    this.expectOperator(":");
    return this.node({ kind: "conditional", condition, consequent, alternate: this.assignment() });
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
    while (this.atOneOf("operator", COMPARISON_OPERATORS)) {
      const operator = this.takeOneOf("operator", COMPARISON_OPERATORS);
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
      expression = this.node({ kind: "in", key: expression, array: this.take().value });
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
    while (this.atOneOf("operator", ADDITIVE_OPERATORS)) {
      const operator = this.takeOneOf("operator", ADDITIVE_OPERATORS);
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
    while (this.atOneOf("operator", MULTIPLICATIVE_OPERATORS)) {
      const operator = this.takeOneOf("operator", MULTIPLICATIVE_OPERATORS);
      expression = this.node({ kind: "binary", operator, left: expression, right: this.unary() });
    }
    return expression;
  }

  private unary(): Expression {
    if (this.atOneOf("operator", UNARY_OPERATORS)) {
      const operator = this.takeOneOf("operator", UNARY_OPERATORS);
      return this.node({ kind: "unary", operator, operand: this.unary() });
    }
    if (this.atOperator("++") || this.atOperator("--")) {
      const delta = this.take().value === "++" ? 1 : -1;
      const target = this.unary();
      if (target.kind !== "variable" && target.kind !== "field" && target.kind !== "array") {
        this.fail("update target is not writable");
      }
      return this.node({ kind: "update", target, delta, prefix: true });
    }
    return this.power();
  }

  private power(): Expression {
    const expression = this.postfix();
    if (!this.atOperator("^")) return expression;
    this.take();
    return this.node({ kind: "binary", operator: "^", left: expression, right: this.unary() });
  }

  private postfix(): Expression {
    const expression = this.primary();
    if (!this.atOperator("++") && !this.atOperator("--")) return expression;
    if (
      expression.kind !== "variable" &&
      expression.kind !== "field" &&
      expression.kind !== "array"
    ) {
      this.fail("update target is not writable");
    }
    const delta = this.take().value === "++" ? 1 : -1;
    return this.node({ kind: "update", target: expression, delta, prefix: false });
  }

  private callExpression(name: string, token: AwkToken): Expression {
    if (!AWK_BUILTINS.has(name)) this.fail(`unsupported function ${name}`, token);
    this.take();
    const arguments_: Expression[] = [];
    while (!this.atOperator(")")) {
      arguments_.push(this.expression());
      if (!this.atOperator(",")) break;
      this.take();
    }
    this.expectOperator(")");
    return this.node({ kind: "call", name, arguments: arguments_ });
  }

  private arrayExpression(name: string): Expression {
    this.take();
    const indices: Expression[] = [];
    do {
      indices.push(this.expression());
      if (!this.atOperator(",")) break;
      this.take();
    } while (!this.atOperator("]"));
    this.expectOperator("]");
    return this.node({ kind: "array", name, indices });
  }

  private identifierExpression(token: AwkToken): Expression {
    if (["function", "getline", "return"].includes(token.value)) {
      this.fail(`unsupported construct ${token.value}`, token);
    }
    if (this.atOperator("(")) return this.callExpression(token.value, token);
    if (token.value === "length") return this.node({ kind: "call", name: "length", arguments: [] });
    if (this.atOperator("[")) return this.arrayExpression(token.value);
    return this.node({ kind: "variable", name: token.value });
  }

  private parenthesizedExpression(): Expression {
    const values = [this.expression()];
    while (this.atOperator(",")) {
      this.take();
      values.push(this.expression());
    }
    this.expectOperator(")");
    const only = values[0];
    if (values.length === 1 && only !== undefined) return only;
    if (!this.atIdentifier("in")) this.fail("a parenthesized expression list requires in");
    return this.node({ kind: "tuple", values });
  }

  private primary(): Expression {
    const token = this.take();
    if (token.kind === "number") return this.node({ kind: "number", value: Number(token.value) });
    if (token.kind === "string") return this.node({ kind: "string", value: token.value });
    if (token.kind === "regex") {
      return this.node({
        kind: "regex",
        pattern: compilePosixRegex(token.value, "extended", "awk"),
      });
    }
    if (token.kind === "identifier") return this.identifierExpression(token);
    if (token.kind === "operator" && token.value === "(") return this.parenthesizedExpression();
    if (token.kind === "operator" && token.value === "$") {
      return this.node({ kind: "field", index: this.unary() });
    }
    this.fail("expected an expression", token);
  }
}

export function parseAwkProgram(
  tokens: readonly AwkToken[],
  maximumNodes: number,
  maximumDepth: number,
): AwkRule[] {
  return new Parser(tokens, maximumNodes, maximumDepth).parse();
}
