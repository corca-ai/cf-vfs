import { VfsError } from "../core/errors.js";
import {
  type ArithmeticOperator,
  type ArithmeticSyntaxError,
  decimalOrOctalInteger,
  arithmeticSyntax as syntax,
  type ArithmeticToken as Token,
  tokenizeArithmetic,
} from "./arithmetic-lexer.js";
import { ShellNounsetError } from "./errors.js";

export { ArithmeticSyntaxError } from "./arithmetic-lexer.js";

type UnaryOperator = "+" | "-" | "!" | "~";
type UpdateOperator = "++" | "--";

const BINARY_PRECEDENCE = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "<": 7,
  "<=": 7,
  ">": 7,
  ">=": 7,
  "<<": 8,
  ">>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 11,
} as const;

type BinaryOperator = keyof typeof BINARY_PRECEDENCE;

const ASSIGNMENT_BINARY = {
  "=": undefined,
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "%=": "%",
  "<<=": "<<",
  ">>=": ">>",
  "&=": "&",
  "^=": "^",
  "|=": "|",
} as const satisfies Readonly<Record<string, BinaryOperator | undefined>>;

type AssignmentOperator = keyof typeof ASSIGNMENT_BINARY;

export type ArithmeticNode =
  | { type: "integer"; value: bigint }
  | { type: "variable"; name: string }
  | { type: "unary"; operator: UnaryOperator; operand: ArithmeticNode }
  | { type: "update"; operator: UpdateOperator; name: string; prefix: boolean }
  | { type: "binary"; operator: BinaryOperator; left: ArithmeticNode; right: ArithmeticNode }
  | {
      type: "conditional";
      condition: ArithmeticNode;
      consequent: ArithmeticNode;
      alternate: ArithmeticNode;
    }
  | { type: "assignment"; operator: AssignmentOperator; name: string; value: ArithmeticNode }
  | { type: "comma"; expressions: ArithmeticNode[] };

export interface ParsedArithmetic {
  node: ArithmeticNode;
  nodeCount: number;
}

function isAssignmentOperator(value: ArithmeticOperator): value is AssignmentOperator {
  return Object.hasOwn(ASSIGNMENT_BINARY, value);
}

function isBinaryOperator(value: ArithmeticOperator): value is BinaryOperator {
  return Object.hasOwn(BINARY_PRECEDENCE, value);
}

class ArithmeticParser {
  private readonly source: string;
  private readonly tokens: readonly Token[];
  private readonly maximumNodes: number;
  private readonly maximumDepth: number;
  private index = 0;
  private nodes = 0;
  private syntaxDepth = 1;

  constructor(source: string, maximumNodes: number, maximumDepth: number) {
    this.source = source;
    this.tokens = tokenizeArithmetic(source);
    this.maximumNodes = maximumNodes;
    this.maximumDepth = maximumDepth;
  }

  parse(): ParsedArithmetic {
    if (this.maximumDepth < 1)
      throw new VfsError("E2BIG", "arithmetic nesting depth limit exceeded");
    const node = this.comma();
    const token = this.peek();
    if (token.type !== "end") throw this.syntax("unexpected token", token.offset);
    validateArithmeticDepth(node, this.maximumDepth);
    return { node, nodeCount: this.nodes };
  }

  private add<T extends ArithmeticNode>(node: T): T {
    this.nodes += 1;
    if (this.nodes > this.maximumNodes) {
      throw new VfsError("E2BIG", "shell AST node limit exceeded");
    }
    return node;
  }

  private syntax(message: string, offset: number): ArithmeticSyntaxError {
    return syntax(message, this.source, offset);
  }

  private nested<T>(parse: () => T): T {
    this.syntaxDepth += 1;
    if (this.syntaxDepth > this.maximumDepth) {
      this.syntaxDepth -= 1;
      throw new VfsError("E2BIG", "arithmetic nesting depth limit exceeded");
    }
    try {
      return parse();
    } finally {
      this.syntaxDepth -= 1;
    }
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { type: "end", offset: 0 };
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private takeOperator(value: ArithmeticOperator): boolean {
    const token = this.peek();
    if (token.type !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private comma(): ArithmeticNode {
    const expressions = [this.assignment()];
    while (this.takeOperator(",")) expressions.push(this.assignment());
    return expressions.length === 1
      ? (expressions[0] ?? this.add({ type: "integer", value: 0n }))
      : this.add({ type: "comma", expressions });
  }

  private assignment(): ArithmeticNode {
    const left = this.conditional();
    const token = this.peek();
    if (token.type !== "operator" || !isAssignmentOperator(token.value)) return left;
    if (left.type !== "variable")
      throw this.syntax("assignment target must be a variable", token.offset);
    this.take();
    return this.add({
      type: "assignment",
      operator: token.value,
      name: left.name,
      value: this.nested(() => this.assignment()),
    });
  }

  private conditional(): ArithmeticNode {
    const condition = this.binary(1);
    if (!this.takeOperator("?")) return condition;
    const consequent = this.nested(() => this.comma());
    const token = this.peek();
    if (!this.takeOperator(":"))
      throw this.syntax("conditional expression requires :", token.offset);
    return this.add({
      type: "conditional",
      condition,
      consequent,
      alternate: this.nested(() => this.assignment()),
    });
  }

  private binary(minimum: number): ArithmeticNode {
    let left = this.unary();
    while (true) {
      const token = this.peek();
      if (token.type !== "operator" || !isBinaryOperator(token.value)) break;
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence < minimum) break;
      this.take();
      const right = this.nested(() =>
        this.binary(token.value === "**" ? precedence : precedence + 1),
      );
      left = this.add({ type: "binary", operator: token.value, left, right });
    }
    return left;
  }

  private unary(): ArithmeticNode {
    const token = this.peek();
    if (token.type === "operator" && (token.value === "++" || token.value === "--")) {
      this.take();
      const operand = this.peek();
      if (operand.type !== "identifier")
        throw this.syntax("update target must be a variable", operand.offset);
      this.take();
      return this.add({ type: "update", operator: token.value, name: operand.value, prefix: true });
    }
    if (
      token.type === "operator" &&
      (token.value === "+" || token.value === "-" || token.value === "!" || token.value === "~")
    ) {
      this.take();
      return this.add({
        type: "unary",
        operator: token.value,
        operand: this.nested(() => this.unary()),
      });
    }
    return this.postfix();
  }

  private postfix(): ArithmeticNode {
    const primary = this.primary();
    const token = this.peek();
    if (token.type !== "operator" || (token.value !== "++" && token.value !== "--")) return primary;
    if (primary.type !== "variable")
      throw this.syntax("update target must be a variable", token.offset);
    this.take();
    return this.add({ type: "update", operator: token.value, name: primary.name, prefix: false });
  }

  private primary(): ArithmeticNode {
    const token = this.take();
    if (token.type === "integer") return this.add({ type: "integer", value: token.value });
    if (token.type === "identifier") return this.add({ type: "variable", name: token.value });
    if (token.type === "operator" && token.value === "(") {
      const expression = this.nested(() => this.comma());
      const close = this.peek();
      if (!this.takeOperator(")")) throw this.syntax("missing closing parenthesis", close.offset);
      return expression;
    }
    throw this.syntax("expected integer, variable, or parenthesized expression", token.offset);
  }
}

function validateArithmeticDepth(root: ArithmeticNode, maximumDepth: number): void {
  const pending: Array<{ node: ArithmeticNode; depth: number }> = [{ node: root, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > maximumDepth) {
      throw new VfsError("E2BIG", "arithmetic nesting depth limit exceeded");
    }
    const nextDepth = current.depth + 1;
    switch (current.node.type) {
      case "unary":
        pending.push({ node: current.node.operand, depth: nextDepth });
        break;
      case "binary":
        pending.push(
          { node: current.node.left, depth: nextDepth },
          { node: current.node.right, depth: nextDepth },
        );
        break;
      case "conditional":
        pending.push(
          { node: current.node.condition, depth: nextDepth },
          { node: current.node.consequent, depth: nextDepth },
          { node: current.node.alternate, depth: nextDepth },
        );
        break;
      case "assignment":
        pending.push({ node: current.node.value, depth: nextDepth });
        break;
      case "comma": {
        for (const expression of current.node.expressions) {
          pending.push({ node: expression, depth: nextDepth });
        }
        break;
      }
      case "integer":
      case "variable":
      case "update":
        break;
    }
  }
}

function int64(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

function truth(value: bigint): bigint {
  return value === 0n ? 0n : 1n;
}

function readVariable(name: string, env: ReadonlyMap<string, string>, nounset: boolean): bigint {
  const value = env.get(name);
  if (value === undefined && nounset) throw new ShellNounsetError(name);
  const normalized = value ?? "";
  if (!/^[+-]?(?:[0-9]+|0[xX][0-9a-f]+)$/iu.test(normalized)) return 0n;
  try {
    const negative = normalized.startsWith("-");
    const unsigned =
      normalized.startsWith("-") || normalized.startsWith("+") ? normalized.slice(1) : normalized;
    const parsed = /^0[xX]/u.test(unsigned) ? BigInt(unsigned) : decimalOrOctalInteger(unsigned);
    if (parsed === undefined) return 0n;
    return int64(negative ? -parsed : parsed);
  } catch {
    return 0n;
  }
}

function divide(left: bigint, right: bigint, remainder: boolean): bigint {
  if (right === 0n) throw new VfsError("EINVAL", "division by zero in arithmetic expression");
  return remainder ? left % right : left / right;
}

function power(left: bigint, right: bigint): bigint {
  if (right < 0n) throw new VfsError("EINVAL", "negative arithmetic exponent");
  if (right > 63n) throw new VfsError("E2BIG", "arithmetic exponent is too large");
  return int64(left ** right);
}

const BINARY_OPERATIONS: Readonly<
  Record<Exclude<BinaryOperator, "**">, (left: bigint, right: bigint) => bigint>
> = {
  "+": (left, right) => int64(left + right),
  "-": (left, right) => int64(left - right),
  "*": (left, right) => int64(left * right),
  "/": (left, right) => int64(divide(left, right, false)),
  "%": (left, right) => int64(divide(left, right, true)),
  "<<": (left, right) => int64(left << BigInt.asUintN(6, right)),
  ">>": (left, right) => int64(left >> BigInt.asUintN(6, right)),
  "<": (left, right) => (left < right ? 1n : 0n),
  "<=": (left, right) => (left <= right ? 1n : 0n),
  ">": (left, right) => (left > right ? 1n : 0n),
  ">=": (left, right) => (left >= right ? 1n : 0n),
  "==": (left, right) => (left === right ? 1n : 0n),
  "!=": (left, right) => (left !== right ? 1n : 0n),
  "&": (left, right) => int64(left & right),
  "^": (left, right) => int64(left ^ right),
  "|": (left, right) => int64(left | right),
  "&&": (left, right) => truth(left) & truth(right),
  "||": (left, right) => truth(left) | truth(right),
};

function binary(operator: BinaryOperator, left: bigint, right: bigint): bigint {
  return operator === "**" ? power(left, right) : BINARY_OPERATIONS[operator](left, right);
}

function assignmentBinary(operator: AssignmentOperator): BinaryOperator | undefined {
  return ASSIGNMENT_BINARY[operator];
}

function unaryValue(node: Extract<ArithmeticNode, { type: "unary" }>, value: bigint): bigint {
  if (node.operator === "+") return value;
  if (node.operator === "-") return int64(-value);
  if (node.operator === "!") return value === 0n ? 1n : 0n;
  return int64(~value);
}

function updateValue(
  node: Extract<ArithmeticNode, { type: "update" }>,
  env: Map<string, string>,
  nounset: boolean,
): bigint {
  const previous = readVariable(node.name, env, nounset);
  const value = int64(previous + (node.operator === "++" ? 1n : -1n));
  env.set(node.name, String(value));
  return node.prefix ? value : previous;
}

function binaryValue(
  node: Extract<ArithmeticNode, { type: "binary" }>,
  env: Map<string, string>,
  nounset: boolean,
): bigint {
  const left = evaluateArithmetic(node.left, env, nounset);
  if (node.operator === "&&" && left === 0n) return 0n;
  if (node.operator === "||" && left !== 0n) return 1n;
  return binary(node.operator, left, evaluateArithmetic(node.right, env, nounset));
}

function assignmentValue(
  node: Extract<ArithmeticNode, { type: "assignment" }>,
  env: Map<string, string>,
  nounset: boolean,
): bigint {
  const operation = assignmentBinary(node.operator);
  const left = operation === undefined ? undefined : readVariable(node.name, env, nounset);
  const right = evaluateArithmetic(node.value, env, nounset);
  const value = operation === undefined ? right : binary(operation, left ?? 0n, right);
  env.set(node.name, String(value));
  return value;
}

function commaValue(
  expressions: readonly ArithmeticNode[],
  env: Map<string, string>,
  nounset: boolean,
): bigint {
  let value = 0n;
  for (const expression of expressions) value = evaluateArithmetic(expression, env, nounset);
  return value;
}

export function evaluateArithmetic(
  node: ArithmeticNode,
  env: Map<string, string>,
  nounset = false,
): bigint {
  switch (node.type) {
    case "integer":
      return int64(node.value);
    case "variable":
      return readVariable(node.name, env, nounset);
    case "unary":
      return unaryValue(node, evaluateArithmetic(node.operand, env, nounset));
    case "update":
      return updateValue(node, env, nounset);
    case "binary":
      return binaryValue(node, env, nounset);
    case "conditional":
      return evaluateArithmetic(
        evaluateArithmetic(node.condition, env, nounset) === 0n ? node.alternate : node.consequent,
        env,
        nounset,
      );
    case "assignment":
      return assignmentValue(node, env, nounset);
    case "comma":
      return commaValue(node.expressions, env, nounset);
  }
}

export function parseArithmetic(
  source: string,
  maximumNodes = 10_000,
  maximumDepth = 64,
): ParsedArithmetic {
  if (source.trim().length === 0) throw syntax("empty expression", source, 0);
  return new ArithmeticParser(source, maximumNodes, maximumDepth).parse();
}
