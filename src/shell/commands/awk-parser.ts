import {
  AWK_BUILTINS,
  type AwkFunction,
  type AwkProgram,
  type AwkRule,
  type Expression,
  LOOP_CONTROL_KINDS,
  PRINT_KINDS,
  type PrintDestination,
  type Statement,
} from "./awk-ast.js";
import { AwkSyntaxError, type AwkToken } from "./awk-lexer.js";
import { AwkExpressionParser } from "./awk-parser-expressions.js";

/** Names declared with `function` or `func`, so a call may precede its definition. */
function functionNames(tokens: readonly AwkToken[]): Set<string> {
  const names = new Set<string>();
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    if (
      token.kind === "identifier" &&
      (token.value === "function" || token.value === "func") &&
      next?.kind === "identifier"
    ) {
      names.add(next.value);
    }
  });
  return names;
}

class Parser extends AwkExpressionParser {
  private loopDepth = 0;
  private inFunction = false;
  readonly functions = new Map<string, AwkFunction>();

  parse(): AwkRule[] {
    const rules: AwkRule[] = [];
    this.separators();
    while (!this.at("eof")) {
      if (this.atIdentifier("function") || this.atIdentifier("func")) {
        this.functionDefinition();
        this.separators();
        continue;
      }
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

  private functionDefinition(): void {
    this.take();
    const name = this.take();
    if (name.kind !== "identifier") this.fail("expected a function name", name);
    if (AWK_BUILTINS.has(name.value) || this.functions.has(name.value)) {
      this.fail(`function ${name.value} is already defined`, name);
    }
    this.expectOperator("(");
    const parameters: string[] = [];
    while (!this.atOperator(")")) {
      const parameter = this.take();
      if (parameter.kind !== "identifier") this.fail("expected a parameter name", parameter);
      parameters.push(parameter.value);
      if (!this.atOperator(",")) break;
      this.take();
      this.consumeNewlines();
    }
    this.expectOperator(")");
    this.consumeNewlines();
    this.inFunction = true;
    try {
      this.functions.set(name.value, { name: name.value, parameters, body: this.block() });
    } finally {
      this.inFunction = false;
    }
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
    return this.atOperator("{") ? this.block() : this.nested(() => [this.statement()]);
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
    while (
      !(parenthesized ? this.atOperator(")") : this.statementEnded() || this.atRedirection())
    ) {
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
    const destination = this.printDestination(values, parenthesized);
    return this.node({ kind, values, ...(destination === undefined ? {} : { destination }) });
  }

  private atRedirection(): boolean {
    return this.atOperator(">") || this.atOperator(">>");
  }

  /**
   * An unparenthesized `print a > f` parses as a comparison, which is the
   * redirection to split off; `>>` and a `>` after a parenthesized list are
   * read directly.
   */
  private printDestination(
    values: Expression[],
    parenthesized: boolean,
  ): PrintDestination | undefined {
    const last = values.at(-1);
    if (!parenthesized && last?.kind === "binary" && last.operator === ">") {
      values[values.length - 1] = last.left;
      return { append: false, target: last.right };
    }
    if (!this.atRedirection()) return undefined;
    const append = this.take().value === ">>";
    return { append, target: this.expression() };
  }

  private ifStatement(): Statement {
    this.take();
    this.expectOperator("(");
    const condition = this.expression();
    this.expectOperator(")");
    this.consumeNewlines();
    const consequent = this.statementBody();
    const beforeElse = this.index;
    // A simple consequent may end with `;` before `else`, as in
    // `if (x) print "a"; else print "b"`.
    if (this.atOperator(";")) this.take();
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

  private returnStatement(): Statement {
    const token = this.take();
    if (!this.inFunction) this.fail("return is only valid inside a function", token);
    return this.node({
      kind: "return",
      ...(this.statementEnded() ? {} : { value: this.expression() }),
    });
  }

  private statement(): Statement {
    if (this.atIdentifier("print") || this.atIdentifier("printf")) return this.printStatement();
    if (this.atIdentifier("return")) return this.returnStatement();
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
}

/** Array containers do not add depth; only executable syntax nodes do. */
function validateTreeDepth(value: unknown, depth: number, maximum: number): void {
  if (Array.isArray(value)) {
    for (const item of value) validateTreeDepth(item, depth, maximum);
    return;
  }
  if (value === null || typeof value !== "object" || !("kind" in value || "phase" in value)) return;
  if (depth >= maximum) throw new AwkSyntaxError("program nesting limit exceeded", 0);
  for (const child of Object.values(value)) validateTreeDepth(child, depth + 1, maximum);
}

export function parseAwkProgram(
  tokens: readonly AwkToken[],
  maximumNodes: number,
  maximumDepth: number,
): AwkProgram {
  const parser = new Parser(tokens, maximumNodes, maximumDepth);
  parser.userFunctions = functionNames(tokens);
  const rules = parser.parse();
  validateTreeDepth(rules, 0, maximumDepth);
  validateTreeDepth(
    [...parser.functions.values()].map((definition) => definition.body),
    0,
    maximumDepth,
  );
  return { rules, functions: parser.functions };
}
