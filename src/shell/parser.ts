import { VfsError } from "../core/errors.js";
import { ArithmeticSyntaxError, parseArithmetic, type ArithmeticNode } from "./arithmetic.js";

export const BASH_COMPATIBILITY_VERSION = 4 as const;

export interface LiteralWordPart {
  kind: "literal";
  value: string;
  quoted: boolean;
}

export type ParameterOperator = "-" | ":-" | "=" | ":=" | "+" | ":+" | "?" | ":?";
export type ParameterDefaultOperator = ParameterOperator;

/** The original Version 2 AST shape, retained for parser API compatibility. */
export interface BasicParameterExpansion {
  name: string;
  length: boolean;
  operator?: ParameterOperator;
  word?: ShellWord;
}

interface AdvancedParameterExpansionBase {
  name: string;
  length: false;
  operator?: undefined;
  word?: undefined;
}

export type ParameterExpansion =
  | BasicParameterExpansion
  | (AdvancedParameterExpansionBase & {
    kind: "remove";
    removalOperator: "#" | "##" | "%" | "%%";
    pattern: ShellWord;
  })
  | (AdvancedParameterExpansionBase & {
    kind: "replace";
    all: boolean;
    pattern: ShellWord;
    replacement: ShellWord;
  })
  | (AdvancedParameterExpansionBase & {
    kind: "substring";
    offset: ShellWord;
    substringLength?: ShellWord;
  });

export interface ParameterWordPart {
  kind: "parameter";
  expansion: ParameterExpansion;
  quoted: boolean;
}

export interface CommandWordPart {
  kind: "command";
  script: ScriptNode;
  quoted: boolean;
}

export interface ArithmeticWordPart {
  kind: "arithmetic";
  expression: ArithmeticNode;
  quoted: boolean;
}

export type WordPart = LiteralWordPart | ParameterWordPart | CommandWordPart | ArithmeticWordPart;

export interface ShellWord {
  parts: WordPart[];
  sourceOffset: number;
  assignmentName?: string;
}

export type PathRedirectionOperator = "<" | ">" | ">>" | "2>" | "2>>";

export type Redirection =
  | { operator: PathRedirectionOperator; target: ShellWord }
  | { operator: "2>&1" }
  | { operator: "<<<"; target: ShellWord }
  | { operator: "<<" | "<<-"; document: ShellWord };

export interface SimpleCommandNode {
  type: "command";
  words: ShellWord[];
  redirections: Redirection[];
  sourceOffset: number;
}

export interface GroupCommandNode {
  type: "group";
  body: ScriptNode;
  subshell: boolean;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface IfCommandNode {
  type: "if";
  branches: Array<{ condition: ScriptNode; body: ScriptNode }>;
  alternate?: ScriptNode;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface LoopCommandNode {
  type: "loop";
  condition: ScriptNode;
  body: ScriptNode;
  until: boolean;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface ForCommandNode {
  type: "for";
  name: string;
  words?: ShellWord[];
  body: ScriptNode;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface CaseCommandNode {
  type: "case";
  word: ShellWord;
  clauses: Array<{ patterns: ShellWord[]; body: ScriptNode }>;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface ArithmeticCommandNode {
  type: "arithmetic-command";
  expression: ArithmeticNode;
  redirections: Redirection[];
  sourceOffset: number;
}

export type ConditionalUnaryOperator = "-n" | "-z" | "-e" | "-f" | "-d";
export type ConditionalBinaryOperator =
  | "==" | "!=" | "<" | ">"
  | "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge";

export type ConditionalExpression =
  | { type: "conditional-word"; word: ShellWord }
  | { type: "conditional-unary"; operator: ConditionalUnaryOperator; operand: ShellWord }
  | {
    type: "conditional-binary";
    operator: ConditionalBinaryOperator;
    left: ShellWord;
    right: ShellWord;
  }
  | { type: "conditional-not"; expression: ConditionalExpression }
  | {
    type: "conditional-boolean";
    operator: "&&" | "||";
    left: ConditionalExpression;
    right: ConditionalExpression;
  }
  | { type: "conditional-group"; expression: ConditionalExpression };

export interface DoubleBracketCommandNode {
  type: "double-bracket";
  expression: ConditionalExpression;
  redirections: Redirection[];
  sourceOffset: number;
}

export type CompoundCommandNode = GroupCommandNode | IfCommandNode | LoopCommandNode
  | ForCommandNode | CaseCommandNode | ArithmeticCommandNode | DoubleBracketCommandNode;

export interface FunctionDefinitionNode {
  type: "function-definition";
  name: string;
  body: CompoundCommandNode;
  sourceOffset: number;
}

export type CommandNode = SimpleCommandNode | CompoundCommandNode | FunctionDefinitionNode;

export interface PipelineNode {
  type: "pipeline";
  negated: boolean;
  commands: CommandNode[];
}

export interface AndOrNode {
  type: "and-or";
  first: PipelineNode;
  rest: Array<{ operator: "&&" | "||"; pipeline: PipelineNode }>;
}

export interface ScriptNode {
  type: "script";
  lists: AndOrNode[];
  nodeCount: number;
}

type Operator = ";" | "\n" | "&&" | "||" | "|" | "!" | "&" | "(" | ")"
  | "{" | "}" | ";;" | PathRedirectionOperator | "2>&1" | "<<" | "<<-" | "<<<";
type OperatorToken = {
  type: "operator";
  value: Operator;
  offset: number;
  document?: ShellWord;
};
type Token =
  | { type: "word"; word: ShellWord }
  | OperatorToken
  | { type: "arithmetic-command"; expression: ArithmeticNode; offset: number };

const PATH_REDIRECTIONS = new Set<Operator>(["<", ">", ">>", "2>", "2>>"]);
const HEREDOC_REDIRECTIONS = new Set<Operator>(["<<", "<<-"]);
const REDIRECTIONS = new Set<Operator>([
  ...PATH_REDIRECTIONS,
  ...HEREDOC_REDIRECTIONS,
  "2>&1",
  "<<<",
]);
const UNSUPPORTED_RESERVED = new Set([
  "then", "elif", "else", "fi", "do", "done", "in", "esac",
  "select", "function", "time", "coproc", "[[", "]]",
]);

const UNSUPPORTED_CONDITIONAL_UNARY = new Set([
  "-a", "-b", "-c", "-g", "-h", "-k", "-L", "-N", "-O", "-p", "-r", "-R",
  "-s", "-S", "-t", "-u", "-v", "-w", "-x",
]);

function conditionalUnaryOperator(value: string | undefined): ConditionalUnaryOperator | undefined {
  if (value === "-n" || value === "-z" || value === "-e" || value === "-f" || value === "-d") {
    return value;
  }
  return undefined;
}

function conditionalBinaryOperator(token: Token | undefined): ConditionalBinaryOperator | undefined {
  if (token?.type === "operator" && (token.value === "<" || token.value === ">")) {
    return token.value;
  }
  if (token?.type !== "word") return undefined;
  const value = staticWord(token.word);
  if (value === "==" || value === "!=" || value === "-eq" || value === "-ne"
    || value === "-lt" || value === "-le" || value === "-gt" || value === "-ge") {
    return value;
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

function utf8ByteOffsets(source: string, checkDeadline: () => void): Uint32Array {
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

function utf8ByteOffset(source: string, offsets: Uint32Array, offset: number): number {
  const checkpoint = Math.floor(offset / BYTE_OFFSET_CHECKPOINT_STRIDE);
  let bytes = offsets[checkpoint] ?? 0;
  for (let index = checkpoint * BYTE_OFFSET_CHECKPOINT_STRIDE; index < offset; index += 1) {
    bytes += utf8PrefixDelta(source, index);
  }
  return bytes;
}

function topLevelDelimiters(
  source: string,
  delimiter: "/" | ":",
  checkDeadline: () => void,
): number[] {
  const offsets: number[] = [];
  let braces = 0;
  let parentheses = 0;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    if ((index & 0xfff) === 0) checkDeadline();
    const character = source[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (source.startsWith("${", index)) {
      braces += 1;
      index += 1;
    } else if (source.startsWith("$(", index)) {
      parentheses += 1;
      index += 1;
    } else if (character === "(" && parentheses > 0) parentheses += 1;
    else if (character === ")" && parentheses > 0) parentheses -= 1;
    else if (character === "}" && braces > 0) braces -= 1;
    else if (character === delimiter && braces === 0 && parentheses === 0) offsets.push(index);
  }
  return offsets;
}

class ParseContext {
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
    if (this.nodes > this.maximumNodes) throw new VfsError("E2BIG", "shell AST node limit exceeded");
  }

  depth(value: number): void {
    this.check();
    if (value > this.maximumDepth) throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
  }

  checkDeadline(): void {
    this.check();
  }

  remainingNodes(): number {
    return this.maximumNodes - this.nodes;
  }
}

function isHorizontalWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\r";
}

function isBoundary(value: string | undefined): boolean {
  return value === undefined || isHorizontalWhitespace(value) || ";\n|&<>()".includes(value);
}

function staticWord(word: ShellWord | undefined): string | undefined {
  if (word === undefined || word.parts.some((part) => part.kind !== "literal" || part.quoted)) return undefined;
  return word.parts.map((part) => part.kind === "literal" ? part.value : "").join("");
}

function literalWordValue(word: ShellWord): { value: string; quoted: boolean } {
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

function assignmentName(parts: readonly WordPart[]): string | undefined {
  const first = parts[0];
  if (first?.kind !== "literal" || first.quoted) return undefined;
  return /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(first.value)?.[1];
}

function operatorAt(source: string, offset: number, atBoundary: boolean): Operator | null {
  for (const candidate of ["2>&1", "<<<", "<<-", "&&", "||", ";;", "2>>", ">>", "<<", "2>"] as const) {
    if (!source.startsWith(candidate, offset)) continue;
    if ((candidate === "2>&1" || candidate === "2>>" || candidate === "2>") && !atBoundary) continue;
    const next = source[offset + candidate.length];
    if (candidate === "2>&1" && !isBoundary(next)) continue;
    return candidate;
  }
  const character = source[offset];
  if (character === ";" || character === "\n" || character === "|" || character === "&"
    || character === ">" || character === "<" || character === "(" || character === ")") return character;
  if ((character === "{" || character === "}") && atBoundary && isBoundary(source[offset + 1])) return character;
  if (character === "!" && atBoundary && isBoundary(source[offset + 1])) return character;
  return null;
}

interface PendingHereDocument {
  token: OperatorToken;
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

class Lexer {
  private readonly source: string;
  private readonly context: ParseContext;
  private readonly baseByteOffset: number;
  private readonly depth: number;
  private readonly byteOffsets: Uint32Array;
  private offset = 0;
  private readonly tokens: Token[] = [];
  private readonly pendingHereDocuments: PendingHereDocument[] = [];
  private expectedHereDocument: OperatorToken | undefined;

  constructor(source: string, context: ParseContext, baseByteOffset: number, depth: number) {
    this.source = source;
    this.context = context;
    this.baseByteOffset = baseByteOffset;
    this.depth = depth;
    this.byteOffsets = utf8ByteOffsets(source, () => context.checkDeadline());
  }

  lex(): Token[] {
    while (this.offset < this.source.length) {
      this.checkOffset(this.offset);
      const character = this.source[this.offset];
      if (character === undefined) break;
      if (isHorizontalWhitespace(character)) {
        this.offset += 1;
        continue;
      }
      if (character === "#") {
        while (this.offset < this.source.length && this.source[this.offset] !== "\n") {
          this.checkOffset(this.offset);
          this.offset += 1;
        }
        continue;
      }
      if (this.source.startsWith("((", this.offset)) {
        this.tokens.push(this.readArithmeticCommand());
        continue;
      }
      if (this.source.startsWith("2>&", this.offset) && operatorAt(this.source, this.offset, true) === null) {
        throw this.error("arbitrary file descriptors are not supported by this language version", this.offset);
      }
      const operator = operatorAt(this.source, this.offset, true);
      if (operator !== null) {
        const token: OperatorToken = {
          type: "operator",
          value: operator,
          offset: this.absoluteOffset(this.offset),
        };
        this.tokens.push(token);
        this.offset += operator.length;
        if (HEREDOC_REDIRECTIONS.has(operator)) this.expectedHereDocument = token;
        if (operator === "\n") this.readPendingHereDocuments();
        continue;
      }
      const word = this.readWord(this.expectedHereDocument !== undefined);
      this.tokens.push({ type: "word", word });
      if (this.expectedHereDocument !== undefined) {
        const delimiter = literalWordValue(word);
        this.pendingHereDocuments.push({
          token: this.expectedHereDocument,
          delimiter: delimiter.value,
          quoted: delimiter.quoted,
          stripTabs: this.expectedHereDocument.value === "<<-",
        });
        this.expectedHereDocument = undefined;
      }
    }
    if (this.expectedHereDocument !== undefined) {
      throw this.error("here-document redirection requires a delimiter", this.source.length);
    }
    if (this.pendingHereDocuments.length > 0) this.readPendingHereDocuments();
    return this.tokens;
  }

  standaloneWord(inheritedQuoted: boolean): ShellWord {
    return this.readWord(false, false, inheritedQuoted);
  }

  standaloneHereDocumentWord(): ShellWord {
    return this.readWord(false, false, true, true);
  }

  private absoluteOffset(offset: number): number {
    return this.baseByteOffset + utf8ByteOffset(this.source, this.byteOffsets, offset);
  }

  private checkOffset(offset: number): void {
    if ((offset & 0xfff) === 0) this.context.checkDeadline();
  }

  private error(message: string, offset: number): VfsError {
    return new VfsError("EINVAL", `${message} at byte ${this.absoluteOffset(offset)}`);
  }

  private parseArithmetic(source: string, sourceOffset: number): ReturnType<typeof parseArithmetic> {
    try {
      return parseArithmetic(source, this.context.remainingNodes(), this.context.maximumDepth);
    } catch (error) {
      if (!(error instanceof ArithmeticSyntaxError)) throw error;
      throw new VfsError(
        "EINVAL",
        `${error.detail} in arithmetic expression at byte ${this.absoluteOffset(sourceOffset) + error.byteOffset}`,
      );
    }
  }

  private append(parts: WordPart[], part: WordPart): void {
    const previous = parts.at(-1);
    if (part.kind === "literal" && previous?.kind === "literal" && previous.quoted === part.quoted) {
      previous.value += part.value;
    } else parts.push(part);
  }

  private readWord(
    delimiterMode: boolean,
    stopAtWhitespace = true,
    inheritedQuoted = false,
    literalQuotes = false,
  ): ShellWord {
    const start = this.offset;
    const parts: WordPart[] = [];
    while (this.offset < this.source.length) {
      this.checkOffset(this.offset);
      const character = this.source[this.offset];
      if (character === undefined) break;
      if (stopAtWhitespace && (isHorizontalWhitespace(character) || character === "\n")) break;
      if (stopAtWhitespace && operatorAt(this.source, this.offset, parts.length === 0) !== null) break;
      if (literalQuotes && (character === "'" || character === "\"")) {
        this.append(parts, { kind: "literal", value: character, quoted: true });
        this.offset += 1;
        continue;
      }
      if (character === "'") {
        const quote = this.offset++;
        let value = "";
        while (this.offset < this.source.length && this.source[this.offset] !== "'") {
          this.checkOffset(this.offset);
          value += this.source[this.offset++] ?? "";
        }
        if (this.source[this.offset] !== "'") throw this.error("unterminated single quote", quote);
        this.offset += 1;
        this.append(parts, { kind: "literal", value, quoted: true });
        continue;
      }
      if (character === "\"") {
        this.readDoubleQuoted(parts, delimiterMode);
        continue;
      }
      if (character === "\\") {
        const next = this.source[this.offset + 1];
        if (next === undefined) throw this.error("unterminated escape", this.offset);
        this.offset += 2;
        if (next !== "\n") {
          const value = literalQuotes && next !== "$" && next !== "\\" && next !== "`"
            ? `\\${next}`
            : next;
          this.append(parts, { kind: "literal", value, quoted: true });
        }
        continue;
      }
      if (character === "`" && !delimiterMode) {
        throw this.error("backtick command substitution is not supported; use $(...)", this.offset);
      }
      if (character === "$" && !delimiterMode) {
        if (this.source[this.offset + 1] === "'" || this.source[this.offset + 1] === "\"") {
          throw this.error("locale and ANSI-C quotes are not supported by this language version", this.offset);
        }
        const expansion = this.readExpansion(inheritedQuoted);
        if (expansion !== undefined) {
          this.append(parts, expansion);
          continue;
        }
      }
      this.append(parts, { kind: "literal", value: character, quoted: inheritedQuoted });
      this.offset += 1;
    }
    if (parts.length === 0) throw this.error("expected word", start);
    const unquoted = parts.every((part) => part.kind === "literal" && !part.quoted)
      ? parts.map((part) => part.kind === "literal" ? part.value : "").join("")
      : undefined;
    const adjacentOperator = operatorAt(this.source, this.offset, false);
    if (unquoted !== undefined && /^[0-9]+$/u.test(unquoted)
      && (adjacentOperator === "<" || adjacentOperator === ">" || adjacentOperator === ">>")) {
      throw this.error("arbitrary file descriptors are not supported by this language version", start);
    }
    const name = assignmentName(parts);
    return {
      parts,
      sourceOffset: this.absoluteOffset(start),
      ...(name === undefined ? {} : { assignmentName: name }),
    };
  }

  private readDoubleQuoted(parts: WordPart[], delimiterMode: boolean): void {
    const start = this.offset++;
    const before = parts.length;
    while (this.offset < this.source.length && this.source[this.offset] !== "\"") {
      this.checkOffset(this.offset);
      const character = this.source[this.offset];
      if (character === "\\") {
        const next = this.source[this.offset + 1];
        if (next === undefined) throw this.error("unterminated escape", this.offset);
        this.offset += 2;
        if (next === "$" || next === "\"" || next === "\\" || next === "\n") {
          if (next !== "\n") this.append(parts, { kind: "literal", value: next, quoted: true });
        } else this.append(parts, { kind: "literal", value: `\\${next}`, quoted: true });
        continue;
      }
      if (character === "`" && !delimiterMode) {
        throw this.error("backtick command substitution is not supported; use $(...)", this.offset);
      }
      if (character === "$" && !delimiterMode) {
        const expansion = this.readExpansion(true);
        if (expansion !== undefined) {
          this.append(parts, expansion);
          continue;
        }
      }
      this.append(parts, { kind: "literal", value: character ?? "", quoted: true });
      this.offset += 1;
    }
    if (this.source[this.offset] !== "\"") throw this.error("unterminated double quote", start);
    this.offset += 1;
    if (parts.length === before) this.append(parts, { kind: "literal", value: "", quoted: true });
  }

  private readExpansion(quoted: boolean): WordPart | undefined {
    const start = this.offset;
    const next = this.source[this.offset + 1];
    if (next === "(") {
      if (this.source[this.offset + 2] === "(") {
        const expression = this.readArithmeticExpansion();
        return { kind: "arithmetic", expression, quoted };
      }
      const script = this.readCommandSubstitution();
      return { kind: "command", script, quoted };
    }
    if (next === "{") {
      const expansion = this.readBracedParameter();
      return { kind: "parameter", expansion, quoted };
    }
    if (next !== undefined && /[A-Za-z_?#@0-9]/u.test(next)) {
      this.offset += 2;
      let name = next;
      if (/[A-Za-z_]/u.test(next)) {
        const suffix = /^[A-Za-z0-9_]*/u.exec(this.source.slice(this.offset))?.[0] ?? "";
        name += suffix;
        this.offset += suffix.length;
      }
      return { kind: "parameter", expansion: { name, length: false }, quoted };
    }
    if (next === "*" || next === "-" || next === "$") {
      throw this.error("special parameter is not supported by this language version", start);
    }
    return undefined;
  }

  private readBracedParameter(): ParameterExpansion {
    const start = this.offset;
    this.offset += 2;
    let length = false;
    if (this.source[this.offset] === "#") {
      length = true;
      this.offset += 1;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[?#@]|[0-9]+)/u.exec(this.source.slice(this.offset))?.[0];
    if (name === undefined) throw this.error("invalid parameter expansion", start);
    this.offset += name.length;
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return { name, length };
    }
    if (length) throw this.error("parameter length expansion does not accept an operator", start);
    const operator = ([":-", ":=", ":+", ":?", "-", "=", "+", "?"] as const)
      .find((candidate) => this.source.startsWith(candidate, this.offset));
    if (operator !== undefined) {
      this.offset += operator.length;
      const operandStart = this.offset;
      const close = this.findParameterClose();
      const word = parseExpansionWord(
        this.source.slice(operandStart, close),
        this.context,
        this.absoluteOffset(operandStart),
        this.depth + 1,
      );
      this.offset = close + 1;
      return { name, length: false, operator, word };
    }
    if (name === "@") {
      throw this.error("array-style parameter operations are not supported", start);
    }
    const removal = (["##", "%%", "#", "%"] as const)
      .find((candidate) => this.source.startsWith(candidate, this.offset));
    if (removal !== undefined) {
      this.offset += removal.length;
      const patternStart = this.offset;
      const close = this.findParameterClose();
      const pattern = parseExpansionWord(
        this.source.slice(patternStart, close),
        this.context,
        this.absoluteOffset(patternStart),
        this.depth + 1,
      );
      this.offset = close + 1;
      return { kind: "remove", name, length: false, removalOperator: removal, pattern };
    }
    if (this.source[this.offset] === "/") {
      const all = this.source[this.offset + 1] === "/";
      this.offset += all ? 2 : 1;
      const patternStart = this.offset;
      const close = this.findParameterClose();
      const contents = this.source.slice(patternStart, close);
      const separator = topLevelDelimiters(
        contents,
        "/",
        () => this.context.checkDeadline(),
      )[0];
      const patternSource = separator === undefined ? contents : contents.slice(0, separator);
      const replacementSource = separator === undefined ? "" : contents.slice(separator + 1);
      if (patternSource.startsWith("#") || patternSource.startsWith("%")) {
        throw this.error("anchored parameter replacement is not supported", patternStart);
      }
      const pattern = parseExpansionWord(
        patternSource,
        this.context,
        this.absoluteOffset(patternStart),
        this.depth + 1,
      );
      const replacementStart = patternStart + (separator ?? contents.length) + (separator === undefined ? 0 : 1);
      const replacement = parseExpansionWord(
        replacementSource,
        this.context,
        this.absoluteOffset(replacementStart),
        this.depth + 1,
      );
      this.offset = close + 1;
      return { kind: "replace", name, length: false, all, pattern, replacement };
    }
    if (this.source[this.offset] === ":") {
      this.offset += 1;
      const offsetStart = this.offset;
      const close = this.findParameterClose();
      const contents = this.source.slice(offsetStart, close);
      const separators = topLevelDelimiters(
        contents,
        ":",
        () => this.context.checkDeadline(),
      );
      if (separators.length > 1) {
        throw this.error("substring expansion accepts at most one length", offsetStart);
      }
      const separator = separators[0];
      const offsetSource = separator === undefined ? contents : contents.slice(0, separator);
      const lengthSource = separator === undefined ? undefined : contents.slice(separator + 1);
      if (offsetSource.trim().length === 0 || lengthSource?.trim().length === 0) {
        throw this.error("substring offset and length must not be empty", offsetStart);
      }
      const offset = parseExpansionWord(
        offsetSource,
        this.context,
        this.absoluteOffset(offsetStart),
        this.depth + 1,
      );
      const lengthStart = offsetStart + (separator ?? contents.length) + 1;
      const substringLength = lengthSource === undefined
        ? undefined
        : parseExpansionWord(
          lengthSource,
          this.context,
          this.absoluteOffset(lengthStart),
          this.depth + 1,
        );
      this.offset = close + 1;
      return {
        kind: "substring",
        name,
        length: false,
        offset,
        ...(substringLength === undefined ? {} : { substringLength }),
      };
    }
    throw this.error("unsupported parameter expansion operator", this.offset);
  }

  private findParameterClose(): number {
    let braces = 0;
    let parentheses = 0;
    let quote: "'" | "\"" | undefined;
    for (let index = this.offset; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "\\" && quote !== "'") {
        index += 1;
        continue;
      }
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === "'" || character === "\"") {
        quote = character;
        continue;
      }
      if (this.source.startsWith("${", index)) {
        braces += 1;
        index += 1;
      } else if (this.source.startsWith("$(", index)) {
        parentheses += 1;
        index += 1;
      } else if (character === ")" && parentheses > 0) parentheses -= 1;
      else if (character === "}" && parentheses === 0) {
        if (braces === 0) return index;
        braces -= 1;
      }
    }
    throw this.error("unterminated parameter expansion", this.offset);
  }

  private readCommandSubstitution(): ScriptNode {
    const start = this.offset;
    const contentStart = this.offset + 2;
    let depth = 1;
    let quote: "'" | "\"" | undefined;
    let index = contentStart;
    for (; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "\\" && quote !== "'") {
        index += 1;
        continue;
      }
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === "'" || character === "\"") {
        quote = character;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw this.error("unterminated command substitution", start);
    this.context.depth(this.depth + 1);
    const script = parseInternal(
      this.source.slice(contentStart, index),
      this.context,
      this.absoluteOffset(contentStart),
      this.depth + 1,
    );
    this.offset = index + 1;
    return script;
  }

  private readArithmeticExpansion(): ArithmeticNode {
    const start = this.offset;
    const contentStart = this.offset + 3;
    let parentheses = 0;
    let index = contentStart;
    for (; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") {
        if (parentheses === 0 && this.source[index + 1] === ")") break;
        parentheses -= 1;
        if (parentheses < 0) throw this.error("invalid arithmetic expansion", start);
      }
    }
    if (index >= this.source.length) throw this.error("unterminated arithmetic expansion", start);
    const parsed = this.parseArithmetic(this.source.slice(contentStart, index), contentStart);
    this.context.add(parsed.nodeCount);
    this.offset = index + 2;
    return parsed.node;
  }

  private readArithmeticCommand(): Token {
    const start = this.offset;
    const contentStart = this.offset + 2;
    let parentheses = 0;
    let index = contentStart;
    for (; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") {
        if (parentheses === 0 && this.source[index + 1] === ")") break;
        parentheses -= 1;
      }
    }
    if (index >= this.source.length) throw this.error("unterminated arithmetic command", start);
    const parsed = this.parseArithmetic(this.source.slice(contentStart, index), contentStart);
    this.context.add(parsed.nodeCount);
    this.offset = index + 2;
    return { type: "arithmetic-command", expression: parsed.node, offset: this.absoluteOffset(start) };
  }

  private readPendingHereDocuments(): void {
    if (this.pendingHereDocuments.length === 0) return;
    const pending = this.pendingHereDocuments.splice(0);
    for (const item of pending) {
      const lines: string[] = [];
      let closed = false;
      while (this.offset <= this.source.length) {
        this.checkOffset(this.offset);
        const lineStart = this.offset;
        const newline = this.source.indexOf("\n", lineStart);
        const lineEnd = newline < 0 ? this.source.length : newline;
        const rawLine = this.source.slice(lineStart, lineEnd);
        const comparison = item.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
        this.offset = newline < 0 ? this.source.length : newline + 1;
        if (comparison === item.delimiter) {
          closed = true;
          break;
        }
        const bodyLine = item.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
        lines.push(`${bodyLine}${newline < 0 ? "" : "\n"}`);
        if (newline < 0) break;
      }
      if (!closed) throw this.error(`unterminated here-document (wanted ${item.delimiter})`, this.offset);
      const body = lines.join("");
      item.token.document = item.quoted
        ? { parts: [{ kind: "literal", value: body, quoted: true }], sourceOffset: item.token.offset }
        : parseHereDocumentWord(body, this.context, item.token.offset, this.depth + 1);
    }
  }
}

function parseExpansionWord(
  source: string,
  context: ParseContext,
  baseByteOffset: number,
  depth: number,
): ShellWord {
  context.depth(depth);
  if (source.length === 0) return { parts: [{ kind: "literal", value: "", quoted: false }], sourceOffset: baseByteOffset };
  const lexer = new Lexer(source, context, baseByteOffset, depth);
  return lexer.standaloneWord(false);
}

function parseHereDocumentWord(
  source: string,
  context: ParseContext,
  baseByteOffset: number,
  depth: number,
): ShellWord {
  context.depth(depth);
  if (source.length === 0) return { parts: [{ kind: "literal", value: "", quoted: true }], sourceOffset: baseByteOffset };
  const lexer = new Lexer(source, context, baseByteOffset, depth);
  return lexer.standaloneHereDocumentWord();
}

interface StopSet {
  words?: ReadonlySet<string>;
  operators?: ReadonlySet<Operator>;
}

class Parser {
  private readonly tokens: readonly Token[];
  private readonly context: ParseContext;
  private readonly depth: number;
  private index = 0;

  constructor(tokens: readonly Token[], context: ParseContext, depth: number) {
    this.tokens = tokens;
    this.context = context;
    this.depth = depth;
  }

  parse(stop: StopSet = {}): ScriptNode {
    const before = this.context.nodes;
    this.context.add();
    const lists: AndOrNode[] = [];
    this.skipSeparators();
    while (this.peek() !== undefined && !this.stopped(stop)) {
      lists.push(this.andOr());
      const token = this.peek();
      if (token === undefined || this.stopped(stop)) break;
      if (!this.isSeparator(token)) throw this.tokenError("expected command separator", token);
      this.skipSeparators();
    }
    return { type: "script", lists, nodeCount: this.context.nodes - before };
  }

  finished(): boolean {
    return this.peek() === undefined;
  }

  private add(): void {
    this.context.add();
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private take(): Token {
    const token = this.tokens[this.index++];
    if (token === undefined) throw new VfsError("EINVAL", "unexpected end of script");
    return token;
  }

  private isSeparator(token: Token | undefined): boolean {
    return token?.type === "operator" && (token.value === ";" || token.value === "\n");
  }

  private skipSeparators(): void {
    while (this.isSeparator(this.peek())) this.index += 1;
  }

  private skipNewlines(): void {
    while (this.peek()?.type === "operator" && this.peekOperator() === "\n") this.index += 1;
  }

  private stopped(stop: StopSet): boolean {
    const token = this.peek();
    if (token?.type === "operator" && stop.operators?.has(token.value) === true) return true;
    if (token?.type === "word") {
      const word = staticWord(token.word);
      if (word !== undefined && stop.words?.has(word) === true) return true;
    }
    return false;
  }

  private tokenError(message: string, token: Token): VfsError {
    const offset = token.type === "word" ? token.word.sourceOffset : token.offset;
    return new VfsError("EINVAL", `${message} at byte ${offset}`);
  }

  private expectWord(value: string): void {
    const token = this.peek();
    if (token?.type !== "word" || staticWord(token.word) !== value) {
      if (token === undefined) throw new VfsError("EINVAL", `expected ${value} at end of script`);
      throw this.tokenError(`expected ${value}`, token);
    }
    this.index += 1;
  }

  private expectOperator(value: Operator): void {
    const token = this.peek();
    if (token?.type !== "operator" || token.value !== value) {
      if (token === undefined) throw new VfsError("EINVAL", `expected ${value} at end of script`);
      throw this.tokenError(`expected ${value}`, token);
    }
    this.index += 1;
  }

  private peekOperator(): Operator | undefined {
    const token = this.peek();
    return token?.type === "operator" ? token.value : undefined;
  }

  private withDepth<T>(run: () => T): T {
    this.context.depth(this.depth + 1);
    return run();
  }

  private andOr(): AndOrNode {
    this.add();
    const first = this.pipeline();
    const rest: AndOrNode["rest"] = [];
    while (true) {
      const token = this.peek();
      if (token?.type !== "operator" || (token.value !== "&&" && token.value !== "||")) break;
      this.take();
      this.skipNewlines();
      rest.push({ operator: token.value, pipeline: this.pipeline() });
    }
    return { type: "and-or", first, rest };
  }

  private pipeline(): PipelineNode {
    this.add();
    let negated = false;
    if (this.peekOperator() === "!") {
      this.take();
      negated = true;
    }
    const commands = [this.command()];
    while (this.peekOperator() === "|") {
      this.take();
      this.skipNewlines();
      commands.push(this.command());
    }
    return { type: "pipeline", negated, commands };
  }

  private command(): CommandNode {
    const token = this.peek();
    if (token === undefined) throw new VfsError("EINVAL", "expected command at end of script");
    if (token.type === "operator") {
      if (token.value === "{") return this.group(false);
      if (token.value === "(") return this.group(true);
      if (token.value === "&") throw this.tokenError("background jobs are not supported", token);
      throw this.tokenError("expected command", token);
    }
    if (token.type === "arithmetic-command") return this.arithmeticCommand();
    const value = staticWord(token.word);
    if (value === "[[") return this.doubleBracketCommand();
    if (value === "if") return this.ifCommand();
    if (value === "while" || value === "until") return this.loopCommand(value === "until");
    if (value === "for") return this.forCommand();
    if (value === "case") return this.caseCommand();
    if (value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
      && this.peek(1)?.type === "operator" && this.peekOperatorAt(1) === "("
      && this.peek(2)?.type === "operator" && this.peekOperatorAt(2) === ")") {
      return this.functionDefinition(value);
    }
    return this.simpleCommand();
  }

  private peekOperatorAt(offset: number): Operator | undefined {
    const token = this.peek(offset);
    return token?.type === "operator" ? token.value : undefined;
  }

  private group(subshell: boolean): GroupCommandNode {
    return this.withDepth(() => {
      const open = this.take();
      const sourceOffset = open.type === "operator" ? open.offset : 0;
      const close: Operator = subshell ? ")" : "}";
      const body = this.parse({ operators: new Set([close]) });
      if (this.peek() === undefined) {
        throw new VfsError("EINVAL", `expected ${close} at byte ${sourceOffset}`);
      }
      this.expectOperator(close);
      const redirections = this.redirections();
      this.add();
      return { type: "group", body, subshell, redirections, sourceOffset };
    });
  }

  private ifCommand(): IfCommandNode {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      const branches: IfCommandNode["branches"] = [];
      let condition = this.parse({ words: new Set(["then"]) });
      this.expectWord("then");
      while (true) {
        const body = this.parse({ words: new Set(["elif", "else", "fi"]) });
        branches.push({ condition, body });
        const next = this.peek();
        if (next?.type !== "word") throw next === undefined
          ? new VfsError("EINVAL", "expected fi at end of script")
          : this.tokenError("expected elif, else, or fi", next);
        const keyword = staticWord(next.word);
        if (keyword === "elif") {
          this.take();
          condition = this.parse({ words: new Set(["then"]) });
          this.expectWord("then");
          continue;
        }
        let alternate: ScriptNode | undefined;
        if (keyword === "else") {
          this.take();
          alternate = this.parse({ words: new Set(["fi"]) });
        }
        this.expectWord("fi");
        const redirections = this.redirections();
        this.add();
        return {
          type: "if",
          branches,
          ...(alternate === undefined ? {} : { alternate }),
          redirections,
          sourceOffset,
        };
      }
    });
  }

  private loopCommand(until: boolean): LoopCommandNode {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      const condition = this.parse({ words: new Set(["do"]) });
      this.expectWord("do");
      const body = this.parse({ words: new Set(["done"]) });
      this.expectWord("done");
      const redirections = this.redirections();
      this.add();
      return { type: "loop", condition, body, until, redirections, sourceOffset };
    });
  }

  private forCommand(): ForCommandNode {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      const nameToken = this.take();
      const name = nameToken.type === "word" ? staticWord(nameToken.word) : undefined;
      if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw this.tokenError("for requires a variable name", nameToken);
      }
      let words: ShellWord[] | undefined;
      if (this.peek()?.type === "word" && staticWord(this.peekWord()) === "in") {
        this.take();
        words = [];
        while (this.peek()?.type === "word") words.push(this.takeWord());
      }
      if (!this.isSeparator(this.peek())) {
        const token = this.peek();
        if (token === undefined) throw new VfsError("EINVAL", "for requires do at end of script");
        throw this.tokenError("for word list requires a separator", token);
      }
      this.skipSeparators();
      this.expectWord("do");
      const body = this.parse({ words: new Set(["done"]) });
      this.expectWord("done");
      const redirections = this.redirections();
      this.add();
      return {
        type: "for",
        name,
        ...(words === undefined ? {} : { words }),
        body,
        redirections,
        sourceOffset,
      };
    });
  }

  private caseCommand(): CaseCommandNode {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      const word = this.takeWord();
      this.skipNewlines();
      this.expectWord("in");
      this.skipSeparators();
      const clauses: CaseCommandNode["clauses"] = [];
      while (this.peek()?.type !== "word" || staticWord(this.peekWord()) !== "esac") {
        if (this.peekOperator() === "(") this.take();
        const patterns: ShellWord[] = [this.takeWord()];
        while (this.peekOperator() === "|") {
          this.take();
          patterns.push(this.takeWord());
        }
        this.expectOperator(")");
        const body = this.parse({ words: new Set(["esac"]), operators: new Set([";;"]) });
        clauses.push({ patterns, body });
        if (this.peekOperator() === ";;") {
          this.take();
          this.skipSeparators();
        } else if (this.peek()?.type !== "word" || staticWord(this.peekWord()) !== "esac") {
          const token = this.peek();
          if (token === undefined) throw new VfsError("EINVAL", "expected esac at end of script");
          throw this.tokenError("case clause requires ;; or esac", token);
        }
      }
      this.expectWord("esac");
      const redirections = this.redirections();
      this.add();
      return { type: "case", word, clauses, redirections, sourceOffset };
    });
  }

  private arithmeticCommand(): ArithmeticCommandNode {
    const token = this.take();
    if (token.type !== "arithmetic-command") throw this.tokenError("expected arithmetic command", token);
    const redirections = this.redirections();
    this.add();
    return {
      type: "arithmetic-command",
      expression: token.expression,
      redirections,
      sourceOffset: token.offset,
    };
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
        throw new VfsError("EINVAL", `[[ ${description} is missing at end of script`);
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
      if (close === undefined) throw new VfsError("EINVAL", "[[ expected ) at end of script");
      throw this.tokenError("[[ expected )", close);
    }
    this.take();
    this.add();
    return { type: "conditional-group", expression };
  }

  private conditionalTest(): ConditionalExpression {
    const first = this.peek();
    if (first === undefined || this.conditionalEnd()
      || (first.type === "operator" && first.value === ")")) {
      if (first === undefined) throw new VfsError("EINVAL", "[[ expression is missing at end of script");
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
      throw new VfsError("EINVAL", `unsupported [[ unary operator ${staticLeft} at byte ${left.sourceOffset}`);
    }

    const operatorToken = this.peek();
    const operator = conditionalBinaryOperator(operatorToken);
    if (operator !== undefined) {
      this.take();
      const right = this.conditionalOperand(`right operand for ${operator}`);
      this.add();
      return { type: "conditional-binary", operator, left, right };
    }
    if (operatorToken !== undefined
      && !this.conditionalEnd()
      && !(operatorToken.type === "operator"
        && (operatorToken.value === "&&" || operatorToken.value === "||" || operatorToken.value === ")"))) {
      throw this.tokenError(
        `unsupported [[ operator ${this.conditionalTokenValue(operatorToken)}`,
        operatorToken,
      );
    }
    this.add();
    return { type: "conditional-word", word: left };
  }

  private doubleBracketCommand(): DoubleBracketCommandNode {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      this.skipNewlines();
      const expression = this.conditionalExpression(1);
      const close = this.peek();
      if (close?.type !== "word" || staticWord(close.word) !== "]]") {
        if (close === undefined) throw new VfsError("EINVAL", `unterminated [[ at byte ${sourceOffset}`);
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

  private functionDefinition(name: string): FunctionDefinitionNode {
    const token = this.take();
    const sourceOffset = token.type === "word" ? token.word.sourceOffset : 0;
    this.expectOperator("(");
    this.expectOperator(")");
    this.skipNewlines();
    const body = this.command();
    if (body.type === "command" || body.type === "function-definition") {
      throw new VfsError("EINVAL", `function body must be a compound command at byte ${sourceOffset}`);
    }
    this.add();
    return { type: "function-definition", name, body, sourceOffset };
  }

  private simpleCommand(): SimpleCommandNode {
    this.add();
    const first = this.peek();
    const sourceOffset = first === undefined ? 0 : first.type === "word" ? first.word.sourceOffset : first.offset;
    const words: ShellWord[] = [];
    const redirections: Redirection[] = [];
    while (true) {
      const token = this.peek();
      if (token?.type === "word") {
        words.push(token.word);
        this.take();
        continue;
      }
      if (token?.type === "operator" && REDIRECTIONS.has(token.value)) {
        redirections.push(this.redirection());
        continue;
      }
      break;
    }
    if (words.length === 0 && redirections.length === 0) {
      if (first === undefined) throw new VfsError("EINVAL", "expected command at end of script");
      throw this.tokenError("expected command", first);
    }
    const commandWord = words.find((word) => word.assignmentName === undefined);
    const rawCommand = staticWord(commandWord);
    if (rawCommand !== undefined && UNSUPPORTED_RESERVED.has(rawCommand)) {
      throw new VfsError("EINVAL", `reserved syntax ${rawCommand} is not supported at byte ${commandWord?.sourceOffset ?? sourceOffset}`);
    }
    if (rawCommand === "[[" || rawCommand === "]]" || /\[[^\]]*\]=/u.test(rawCommand ?? "")) {
      throw new VfsError("EINVAL", `array and extended-test syntax is not supported at byte ${commandWord?.sourceOffset ?? sourceOffset}`);
    }
    for (const word of words) {
      const raw = staticWord(word);
      if (raw !== undefined && /\{[^{}]*,[^{}]*\}/u.test(raw)) {
        throw new VfsError("EINVAL", `brace expansion is not supported at byte ${word.sourceOffset}`);
      }
    }
    return { type: "command", words, redirections, sourceOffset };
  }

  private redirections(): Redirection[] {
    const output: Redirection[] = [];
    while (this.peek()?.type === "operator" && REDIRECTIONS.has(this.peekOperator() ?? ";")) {
      output.push(this.redirection());
    }
    return output;
  }

  private redirection(): Redirection {
    const token = this.take();
    if (token.type !== "operator" || !REDIRECTIONS.has(token.value)) {
      throw this.tokenError("expected redirection", token);
    }
    if (token.value === "2>&1") return { operator: "2>&1" };
    const target = this.take();
    if (target.type !== "word") throw this.tokenError("redirection requires a word", target);
    if (token.value === "<<" || token.value === "<<-") {
      if (token.document === undefined) throw this.tokenError("here-document body is missing", token);
      return { operator: token.value, document: token.document };
    }
    if (token.value === "<<<") return { operator: "<<<", target: target.word };
    if (!PATH_REDIRECTIONS.has(token.value)) throw this.tokenError("unsupported redirection", token);
    return { operator: token.value as PathRedirectionOperator, target: target.word };
  }

  private takeWord(): ShellWord {
    const token = this.take();
    if (token.type !== "word") throw this.tokenError("expected word", token);
    return token.word;
  }

  private peekWord(): ShellWord | undefined {
    const token = this.peek();
    return token?.type === "word" ? token.word : undefined;
  }

  private takeWordOffset(): number {
    return this.takeWord().sourceOffset;
  }
}

function parseInternal(
  source: string,
  context: ParseContext,
  baseByteOffset: number,
  depth: number,
): ScriptNode {
  context.depth(depth);
  const tokens = new Lexer(source, context, baseByteOffset, depth).lex();
  const parser = new Parser(tokens, context, depth);
  const script = parser.parse();
  if (!parser.finished()) throw new VfsError("EINVAL", "unexpected trailing shell syntax");
  return script;
}

function validateWordDepth(word: ShellWord, maximumDepth: number, depth: number): void {
  if (depth > maximumDepth) throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
  for (const part of word.parts) {
    if (part.kind === "command") validateScriptDepth(part.script, maximumDepth, depth + 1);
    else if (part.kind === "parameter") {
      const expansion = part.expansion;
      if (!("kind" in expansion)) {
        if (expansion.word !== undefined) {
          validateWordDepth(expansion.word, maximumDepth, depth + 1);
        }
      } else if (expansion.kind === "remove") {
        validateWordDepth(expansion.pattern, maximumDepth, depth + 1);
      } else if (expansion.kind === "replace") {
        validateWordDepth(expansion.pattern, maximumDepth, depth + 1);
        validateWordDepth(expansion.replacement, maximumDepth, depth + 1);
      } else if (expansion.kind === "substring") {
        validateWordDepth(expansion.offset, maximumDepth, depth + 1);
        if (expansion.substringLength !== undefined) {
          validateWordDepth(expansion.substringLength, maximumDepth, depth + 1);
        }
      }
    }
  }
}

function validateRedirectionDepth(
  redirection: Redirection,
  maximumDepth: number,
  depth: number,
): void {
  if ("target" in redirection) validateWordDepth(redirection.target, maximumDepth, depth);
  else if ("document" in redirection) validateWordDepth(redirection.document, maximumDepth, depth);
}

function validateConditionalDepth(
  expression: ConditionalExpression,
  maximumDepth: number,
  depth: number,
): void {
  const pending: Array<{ expression: ConditionalExpression; depth: number }> = [{ expression, depth }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > maximumDepth) {
      throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
    }
    const item = current.expression;
    if (item.type === "conditional-word") {
      validateWordDepth(item.word, maximumDepth, current.depth);
    } else if (item.type === "conditional-unary") {
      validateWordDepth(item.operand, maximumDepth, current.depth);
    } else if (item.type === "conditional-binary") {
      validateWordDepth(item.left, maximumDepth, current.depth);
      validateWordDepth(item.right, maximumDepth, current.depth);
    } else if (item.type === "conditional-not" || item.type === "conditional-group") {
      pending.push({ expression: item.expression, depth: current.depth + 1 });
    } else {
      pending.push(
        { expression: item.right, depth: current.depth },
        { expression: item.left, depth: current.depth },
      );
    }
  }
}

function validateCommandDepth(node: CommandNode, maximumDepth: number, depth: number): void {
  if (depth > maximumDepth) throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
  if (node.type === "command") {
    for (const word of node.words) validateWordDepth(word, maximumDepth, depth);
    for (const item of node.redirections) validateRedirectionDepth(item, maximumDepth, depth);
    return;
  }
  if (node.type === "function-definition") {
    validateCommandDepth(node.body, maximumDepth, depth + 1);
    return;
  }
  for (const item of node.redirections) validateRedirectionDepth(item, maximumDepth, depth);
  if (node.type === "group") validateScriptDepth(node.body, maximumDepth, depth + 1);
  else if (node.type === "if") {
    for (const branch of node.branches) {
      validateScriptDepth(branch.condition, maximumDepth, depth + 1);
      validateScriptDepth(branch.body, maximumDepth, depth + 1);
    }
    if (node.alternate !== undefined) validateScriptDepth(node.alternate, maximumDepth, depth + 1);
  } else if (node.type === "loop") {
    validateScriptDepth(node.condition, maximumDepth, depth + 1);
    validateScriptDepth(node.body, maximumDepth, depth + 1);
  } else if (node.type === "for") {
    for (const word of node.words ?? []) validateWordDepth(word, maximumDepth, depth);
    validateScriptDepth(node.body, maximumDepth, depth + 1);
  } else if (node.type === "case") {
    validateWordDepth(node.word, maximumDepth, depth);
    for (const clause of node.clauses) {
      for (const pattern of clause.patterns) validateWordDepth(pattern, maximumDepth, depth);
      validateScriptDepth(clause.body, maximumDepth, depth + 1);
    }
  } else if (node.type === "double-bracket") {
    validateConditionalDepth(node.expression, maximumDepth, depth + 1);
  }
}

function validateScriptDepth(script: ScriptNode, maximumDepth: number, depth: number): void {
  if (depth > maximumDepth) throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
  for (const list of script.lists) {
    for (const pipeline of [list.first, ...list.rest.map((item) => item.pipeline)]) {
      for (const command of pipeline.commands) validateCommandDepth(command, maximumDepth, depth);
    }
  }
}

export function parseShellScript(
  script: string,
  maximumNodes: number,
  maximumDepth = 64,
  accountNodes: (count: number) => void = () => undefined,
  checkDeadline: () => void = () => undefined,
): ScriptNode {
  const context = new ParseContext(maximumNodes, maximumDepth, accountNodes, checkDeadline);
  const parsed = parseInternal(script, context, 0, 1);
  const result = { ...parsed, nodeCount: context.nodes };
  validateScriptDepth(result, maximumDepth, 1);
  return result;
}
