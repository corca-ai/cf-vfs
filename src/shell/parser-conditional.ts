import { VfsError } from "../core/errors.js";
import type {
  ConditionalExpression,
  DoubleBracketCommandNode,
  Redirection,
  ShellWord,
} from "./parser-ast.js";
import { ParserCursor } from "./parser-cursor.js";
import { incompleteShellSyntaxError } from "./parser-errors.js";
import {
  conditionalBinaryOperator,
  conditionalUnaryOperator,
  staticWord,
  type Token,
  UNSUPPORTED_CONDITIONAL_UNARY,
} from "./parser-support.js";

export abstract class ConditionalParser extends ParserCursor {
  protected abstract redirections(): Redirection[];

  protected doubleBracketCommand(): DoubleBracketCommandNode {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      this.skipNewlines();
      const expression = this.conditionalExpression(1);
      const close = this.peek();
      if (close?.type !== "word" || staticWord(close.word) !== "]]") {
        if (close === undefined) {
          throw incompleteShellSyntaxError(`unterminated [[ at byte ${sourceOffset}`);
        }
        throw this.tokenError(
          `unexpected token ${this.conditionalTokenValue(close)} in [[ expression`,
          close,
        );
      }
      this.take();
      const redirections = this.redirections();
      this.add();
      return { type: "double-bracket", expression, redirections, sourceOffset };
    });
  }

  private conditionalEnd(): boolean {
    const token = this.peek();
    return token?.type === "word" && staticWord(token.word) === "]]";
  }

  private conditionalTokenValue(token: Token): string {
    if (token.type === "operator") return token.value;
    if (token.type === "arithmetic-command") return "((...))";
    return staticWord(token.word) ?? "expanded word";
  }

  private conditionalOperand(description: string): ShellWord {
    const token = this.peek();
    if (token?.type !== "word" || this.conditionalEnd()) {
      if (token === undefined) {
        throw incompleteShellSyntaxError(`[[ ${description} is missing at end of script`);
      }
      throw this.tokenError(`[[ ${description} is missing`, token);
    }
    this.take();
    return token.word;
  }

  private conditionalExpression(depth: number): ConditionalExpression {
    this.context.depth(this.depth + depth);
    return this.conditionalOr(depth);
  }

  private conditionalOr(depth: number): ConditionalExpression {
    let left = this.conditionalAnd(depth);
    while (this.peekOperator() === "||") {
      this.take();
      this.skipNewlines();
      const right = this.conditionalAnd(depth);
      this.add();
      left = { type: "conditional-boolean", operator: "||", left, right };
    }
    return left;
  }

  private conditionalAnd(depth: number): ConditionalExpression {
    let left = this.conditionalNot(depth);
    while (this.peekOperator() === "&&") {
      this.take();
      this.skipNewlines();
      const right = this.conditionalNot(depth);
      this.add();
      left = { type: "conditional-boolean", operator: "&&", left, right };
    }
    return left;
  }

  private conditionalNot(depth: number): ConditionalExpression {
    if (this.peekOperator() !== "!") return this.conditionalPrimary(depth);
    this.take();
    this.skipNewlines();
    this.context.depth(this.depth + depth + 1);
    const expression = this.conditionalNot(depth + 1);
    this.add();
    return { type: "conditional-not", expression };
  }

  private conditionalPrimary(depth: number): ConditionalExpression {
    if (this.peekOperator() !== "(") return this.conditionalTest();
    this.take();
    this.skipNewlines();
    this.context.depth(this.depth + depth + 1);
    const expression = this.conditionalOr(depth + 1);
    const close = this.peek();
    if (close?.type !== "operator" || close.value !== ")") {
      if (close === undefined) throw incompleteShellSyntaxError("[[ expected ) at end of script");
      throw this.tokenError("[[ expected )", close);
    }
    this.take();
    this.add();
    return { type: "conditional-group", expression };
  }

  private conditionalTest(): ConditionalExpression {
    const first = this.peek();
    if (first === undefined || this.conditionalEnd() || this.isConditionalGroupEnd(first)) {
      if (first === undefined) {
        throw incompleteShellSyntaxError("[[ expression is missing at end of script");
      }
      throw this.tokenError("[[ expression is missing", first);
    }
    if (first.type !== "word") throw this.tokenError("[[ expected an operand", first);
    const left = this.takeWord();
    const staticLeft = staticWord(left);
    const unary = conditionalUnaryOperator(staticLeft);
    if (unary !== undefined) {
      const operand = this.conditionalOperand(`operand for ${unary}`);
      this.add();
      return { type: "conditional-unary", operator: unary, operand };
    }
    if (staticLeft !== undefined && UNSUPPORTED_CONDITIONAL_UNARY.has(staticLeft)) {
      throw new VfsError(
        "EINVAL",
        `unsupported [[ unary operator ${staticLeft} at byte ${left.sourceOffset}`,
      );
    }
    return this.conditionalBinaryOrWord(left);
  }

  private conditionalBinaryOrWord(left: ShellWord): ConditionalExpression {
    const operatorToken = this.peek();
    const operator = conditionalBinaryOperator(operatorToken);
    if (operator !== undefined) {
      this.take();
      const right = this.conditionalOperand(`right operand for ${operator}`);
      this.add();
      return { type: "conditional-binary", operator, left, right };
    }
    if (operatorToken !== undefined && !this.isConditionalTerminator(operatorToken)) {
      throw this.tokenError(
        `unsupported [[ operator ${this.conditionalTokenValue(operatorToken)}`,
        operatorToken,
      );
    }
    this.add();
    return { type: "conditional-word", word: left };
  }

  private isConditionalGroupEnd(token: Token): boolean {
    return token.type === "operator" && token.value === ")";
  }

  private isConditionalTerminator(token: Token): boolean {
    if (token.type === "word") return staticWord(token.word) === "]]";
    return token.type === "operator" && ["&&", "||", ")"].includes(token.value);
  }
}
