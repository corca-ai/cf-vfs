import { compilePosixRegex } from "../../core/posix-regex.js";
import {
  ADDITIVE_OPERATORS,
  ASSIGNMENT_OPERATORS,
  AWK_BUILTINS,
  COMPARISON_OPERATORS,
  type Expression,
  MULTIPLICATIVE_OPERATORS,
  UNARY_OPERATORS,
} from "./awk-ast.js";
import { type AwkToken, awkRegexSource } from "./awk-lexer.js";
import { AwkParserCursor } from "./awk-parser-cursor.js";

/** Expression grammar, from assignment down to primaries; statements build on it. */
export class AwkExpressionParser extends AwkParserCursor {
  /** Names declared with `function`, which a call may use before the definition. */
  userFunctions = new Set<string>();

  protected expression(): Expression {
    return this.assignment();
  }

  private assignment(): Expression {
    const left = this.conditional();
    if (!this.atOneOf("operator", ASSIGNMENT_OPERATORS)) return left;
    if (left.kind !== "variable" && left.kind !== "field" && left.kind !== "array") {
      this.fail("assignment target is not writable");
    }
    const operator = this.takeOneOf("operator", ASSIGNMENT_OPERATORS);
    return this.node({
      kind: "assign",
      target: left,
      operator,
      value: this.nested(() => this.assignment()),
    });
  }

  private conditional(): Expression {
    const condition = this.logicalOr();
    if (!this.atOperator("?")) return condition;
    this.take();
    const consequent = this.nested(() => this.assignment());
    this.expectOperator(":");
    return this.node({
      kind: "conditional",
      condition,
      consequent,
      alternate: this.nested(() => this.assignment()),
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
      expression = this.node({
        kind: "binary",
        operator,
        left: expression,
        right: this.nested(() => this.unary()),
      });
    }
    return expression;
  }

  private unary(): Expression {
    if (this.atOneOf("operator", UNARY_OPERATORS)) {
      const operator = this.takeOneOf("operator", UNARY_OPERATORS);
      return this.node({ kind: "unary", operator, operand: this.nested(() => this.unary()) });
    }
    if (this.atOperator("++") || this.atOperator("--")) {
      const delta = this.take().value === "++" ? 1 : -1;
      const target = this.nested(() => this.unary());
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
    return this.node({
      kind: "binary",
      operator: "^",
      left: expression,
      right: this.nested(() => this.unary()),
    });
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
    const user = !AWK_BUILTINS.has(name);
    if (user && !this.userFunctions.has(name)) {
      this.fail(`calling undefined function ${name}`, token);
    }
    this.take();
    const arguments_: Expression[] = [];
    while (!this.atOperator(")")) {
      arguments_.push(this.expression());
      if (!this.atOperator(",")) break;
      this.take();
    }
    this.expectOperator(")");
    return this.node({ kind: user ? "user-call" : "call", name, arguments: arguments_ });
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
    if (["function", "func", "getline", "return"].includes(token.value)) {
      this.fail(`unsupported construct ${token.value}`, token);
    }
    // A built-in may be followed by blanks before its `(`; any other name
    // followed by blanks and `(` is a variable concatenated with a group, as
    // in `out = out (sep) x`, because a user function call has no blank.
    const adjacent = this.current().offset === token.offset + token.value.length;
    if (this.atOperator("(") && (adjacent || AWK_BUILTINS.has(token.value))) {
      return this.nested(() => this.callExpression(token.value, token));
    }
    if (token.value === "length") return this.node({ kind: "call", name: "length", arguments: [] });
    if (this.atOperator("[")) return this.nested(() => this.arrayExpression(token.value));
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

  protected primary(): Expression {
    const token = this.take();
    if (token.kind === "number") return this.node({ kind: "number", value: Number(token.value) });
    if (token.kind === "string") return this.node({ kind: "string", value: token.value });
    if (token.kind === "regex") {
      return this.node({
        kind: "regex",
        pattern: compilePosixRegex(awkRegexSource(token.value), "extended", "awk"),
      });
    }
    if (token.kind === "identifier") return this.identifierExpression(token);
    if (token.kind === "operator" && token.value === "(")
      return this.nested(() => this.parenthesizedExpression());
    if (token.kind === "operator" && token.value === "$") {
      return this.node({ kind: "field", index: this.nested(() => this.unary()) });
    }
    this.fail("expected an expression", token);
  }
}
