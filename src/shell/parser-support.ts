import { VfsError } from "../core/errors.js";
import type { ArithmeticNode } from "./arithmetic.js";
import type {
  ConditionalBinaryOperator,
  ConditionalUnaryOperator,
  PathRedirectionOperator,
  ShellWord,
  WordPart,
} from "./parser-ast.js";

const PATH_REDIRECTION_OPERATORS = ["<", ">", ">>", "2>", "2>>", "&>", "&>>"] as const;

export type Operator =
  | ";"
  | "\n"
  | "&&"
  | "||"
  | "|"
  | "!"
  | "&"
  | "("
  | ")"
  | "{"
  | "}"
  | ";;"
  | PathRedirectionOperator
  | "2>&1"
  | ">&2"
  | "<<"
  | "<<-"
  | "<<<";
export type OperatorToken = {
  type: "operator";
  value: Operator;
  offset: number;
  document?: ShellWord;
};
export type Token =
  | { type: "word"; word: ShellWord }
  | OperatorToken
  | { type: "arithmetic-command"; expression: ArithmeticNode; offset: number };

const PATH_REDIRECTIONS = new Set<Operator>(PATH_REDIRECTION_OPERATORS);
export const HEREDOC_REDIRECTIONS = new Set<Operator>(["<<", "<<-"]);
export const REDIRECTIONS = new Set<Operator>([
  ...PATH_REDIRECTIONS,
  ...HEREDOC_REDIRECTIONS,
  "2>&1",
  ">&2",
  "<<<",
]);

export function isPathRedirectionOperator(value: Operator): value is PathRedirectionOperator {
  return PATH_REDIRECTIONS.has(value);
}
export const UNSUPPORTED_RESERVED = new Set([
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "in",
  "esac",
  "select",
  "function",
  "time",
  "coproc",
  "[[",
  "]]",
]);

export const UNSUPPORTED_CONDITIONAL_UNARY = new Set([
  "-a",
  "-b",
  "-g",
  "-k",
  "-N",
  "-O",
  "-p",
  "-r",
  "-R",
  "-s",
  "-S",
  "-t",
  "-u",
  "-w",
  "-x",
]);

const CONDITIONAL_UNARY_OPERATORS: readonly ConditionalUnaryOperator[] = [
  "-n",
  "-z",
  "-e",
  "-f",
  "-d",
  "-s",
  "-r",
  "-w",
  "-x",
  "-L",
  "-h",
  "-c",
  "-v",
];

export function conditionalUnaryOperator(
  value: string | undefined,
): ConditionalUnaryOperator | undefined {
  return CONDITIONAL_UNARY_OPERATORS.find((candidate) => candidate === value);
}

export function conditionalBinaryOperator(
  token: Token | undefined,
): ConditionalBinaryOperator | undefined {
  if (token?.type === "operator" && (token.value === "<" || token.value === ">")) {
    return token.value;
  }
  if (token?.type !== "word") return undefined;
  const value = staticWord(token.word);
  if (
    value === "==" ||
    value === "=" ||
    value === "!=" ||
    value === "-eq" ||
    value === "-ne" ||
    value === "-lt" ||
    value === "-le" ||
    value === "-gt" ||
    value === "-ge"
  ) {
    return value === "=" ? "==" : value;
  }
  return undefined;
}

const BYTE_OFFSET_CHECKPOINT_STRIDE = 256;

function utf8PrefixDelta(source: string, index: number): number {
  const value = source.charCodeAt(index);
  if (value >= 0xdc00 && value <= 0xdfff) {
    const previous = source.charCodeAt(index - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) return 1;
  }
  return value <= 0x7f ? 1 : value <= 0x7ff ? 2 : 3;
}

export function utf8ByteOffsets(source: string, checkDeadline: () => void): Uint32Array {
  const offsets = new Uint32Array(Math.floor(source.length / BYTE_OFFSET_CHECKPOINT_STRIDE) + 1);
  let bytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ((index & 0xfff) === 0) checkDeadline();
    bytes += utf8PrefixDelta(source, index);
    const next = index + 1;
    if (next % BYTE_OFFSET_CHECKPOINT_STRIDE === 0) {
      offsets[next / BYTE_OFFSET_CHECKPOINT_STRIDE] = bytes;
    }
  }
  checkDeadline();
  return offsets;
}

export function utf8ByteOffset(source: string, offsets: Uint32Array, offset: number): number {
  const checkpoint = Math.floor(offset / BYTE_OFFSET_CHECKPOINT_STRIDE);
  let bytes = offsets[checkpoint] ?? 0;
  for (let index = checkpoint * BYTE_OFFSET_CHECKPOINT_STRIDE; index < offset; index += 1) {
    bytes += utf8PrefixDelta(source, index);
  }
  return bytes;
}

class TopLevelDelimiterScanner {
  private braces = 0;
  private parentheses = 0;
  private quote: "'" | '"' | undefined;

  constructor(
    private readonly source: string,
    private readonly delimiter: "/" | ":" | "}",
    private readonly offsets: number[],
  ) {}

  private consumeQuote(character: string | undefined): boolean {
    if (this.quote !== undefined) {
      if (character === this.quote) this.quote = undefined;
      return true;
    }
    if (character !== "'" && character !== '"') return false;
    this.quote = character;
    return true;
  }

  private consumeNesting(index: number, character: string | undefined): boolean {
    if (this.source.startsWith("${", index)) this.braces += 1;
    else if (this.source.startsWith("$(", index)) this.parentheses += 1;
    else if (character === "(" && this.parentheses > 0) this.parentheses += 1;
    else if (character === ")" && this.parentheses > 0) this.parentheses -= 1;
    else if (character === "}" && this.braces > 0) this.braces -= 1;
    else return false;
    return true;
  }

  advance(index: number): number {
    const character = this.source[index];
    if (character === "\\" && this.quote !== "'") return 2;
    if (this.consumeQuote(character)) return 1;
    if (this.consumeNesting(index, character)) {
      return this.source.startsWith("$", index) ? 2 : 1;
    }
    if (character === this.delimiter && this.braces === 0 && this.parentheses === 0) {
      this.offsets.push(index);
    }
    return 1;
  }
}

export function topLevelDelimiters(
  source: string,
  delimiter: "/" | ":" | "}",
  checkDeadline: () => void,
  start = 0,
): number[] {
  const offsets: number[] = [];
  const scanner = new TopLevelDelimiterScanner(source, delimiter, offsets);
  for (let index = start; index < source.length; ) {
    if ((index & 0xfff) === 0) checkDeadline();
    index += scanner.advance(index);
  }
  return offsets;
}

export class ParseContext {
  readonly maximumNodes: number;
  readonly maximumDepth: number;
  private readonly accountNodes: (count: number) => void;
  private readonly check: () => void;
  nodes = 0;

  constructor(
    maximumNodes: number,
    maximumDepth: number,
    accountNodes: (count: number) => void,
    checkDeadline: () => void,
  ) {
    this.maximumNodes = maximumNodes;
    this.maximumDepth = maximumDepth;
    this.accountNodes = accountNodes;
    this.check = checkDeadline;
  }

  add(count = 1): void {
    this.check();
    this.nodes += count;
    this.accountNodes(count);
    if (this.nodes > this.maximumNodes)
      throw new VfsError("E2BIG", "shell AST node limit exceeded");
  }

  depth(value: number): void {
    this.check();
    if (value > this.maximumDepth)
      throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
  }

  checkDeadline(): void {
    this.check();
  }

  remainingNodes(): number {
    return this.maximumNodes - this.nodes;
  }
}

export function isHorizontalWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\r";
}

export function isBoundary(value: string | undefined): boolean {
  return value === undefined || isHorizontalWhitespace(value) || ";\n|&<>()".includes(value);
}

export function staticWord(word: ShellWord | undefined): string | undefined {
  if (word === undefined || word.parts.some((part) => part.kind !== "literal" || part.quoted))
    return undefined;
  return word.parts.map((part) => (part.kind === "literal" ? part.value : "")).join("");
}

export function literalWordValue(word: ShellWord): { value: string; quoted: boolean } {
  let value = "";
  let quoted = false;
  for (const part of word.parts) {
    if (part.kind !== "literal") {
      throw new VfsError("EINVAL", "here-document delimiter must be a literal word");
    }
    value += part.value;
    quoted ||= part.quoted;
  }
  return { value, quoted };
}

export function assignmentName(parts: readonly WordPart[]): string | undefined {
  const first = parts[0];
  if (first?.kind !== "literal" || first.quoted) return undefined;
  return /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(first.value)?.[1];
}

const MULTI_CHARACTER_OPERATORS = [
  "2>&1",
  ">&2",
  "<<<",
  "<<-",
  "&&",
  "||",
  ";;",
  "2>>",
  ">>",
  "<<",
  "2>",
] as const;
const BOUNDARY_PREFIX_OPERATORS = new Set<Operator>(["2>&1", "2>>", "2>"]);
const BOUNDARY_SUFFIX_OPERATORS = new Set<Operator>(["2>&1", ">&2"]);
const SINGLE_CHARACTER_OPERATORS = new Set([";", "\n", "|", ">", "<", "(", ")"]);

function validMultiCharacterOperator(
  source: string,
  offset: number,
  candidate: Operator,
  atBoundary: boolean,
): boolean {
  if (!source.startsWith(candidate, offset)) return false;
  if (BOUNDARY_PREFIX_OPERATORS.has(candidate) && !atBoundary) return false;
  const next = source[offset + candidate.length];
  return !BOUNDARY_SUFFIX_OPERATORS.has(candidate) || isBoundary(next);
}

function singleCharacterOperator(
  source: string,
  offset: number,
  atBoundary: boolean,
): Operator | null {
  const character = source[offset] ?? "";
  if (character === "&") {
    if (source[offset + 1] !== ">") return "&";
    return source[offset + 2] === ">" ? "&>>" : "&>";
  }
  if (SINGLE_CHARACTER_OPERATORS.has(character)) return character as Operator;
  const boundaryOperator = character === "{" || character === "}" || character === "!";
  return boundaryOperator && atBoundary && isBoundary(source[offset + 1])
    ? (character as Operator)
    : null;
}

export function operatorAt(source: string, offset: number, atBoundary: boolean): Operator | null {
  for (const candidate of MULTI_CHARACTER_OPERATORS) {
    if (validMultiCharacterOperator(source, offset, candidate, atBoundary)) return candidate;
  }
  return singleCharacterOperator(source, offset, atBoundary);
}
