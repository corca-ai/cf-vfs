import { VfsError } from "../core/errors.js";
import { ArithmeticSyntaxError, parseArithmetic } from "./arithmetic.js";
import type { ScriptNode, ShellWord, WordPart } from "./parser-ast.js";
import { incompleteShellSyntaxError } from "./parser-errors.js";
import {
  HEREDOC_REDIRECTIONS,
  isBoundary,
  isHorizontalWhitespace,
  literalWordValue,
  type OperatorToken,
  operatorAt,
  type ParseContext,
  type Token,
  utf8ByteOffset,
  utf8ByteOffsets,
} from "./parser-support.js";

export interface PendingHereDocument {
  token: OperatorToken;
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

export type NestedParser = (
  source: string,
  context: ParseContext,
  baseByteOffset: number,
  depth: number,
) => ScriptNode;

export abstract class ShellLexerBase {
  protected readonly byteOffsets: Uint32Array;
  protected offset = 0;
  protected readonly tokens: Token[] = [];
  protected readonly pendingHereDocuments: PendingHereDocument[] = [];
  protected expectedHereDocument: OperatorToken | undefined;

  constructor(
    protected readonly source: string,
    protected readonly context: ParseContext,
    protected readonly baseByteOffset: number,
    protected readonly depth: number,
    protected readonly parseNested: NestedParser,
  ) {
    this.byteOffsets = utf8ByteOffsets(source, () => context.checkDeadline());
  }

  protected abstract readWord(
    delimiterMode?: boolean,
    stopAtDoubleQuote?: boolean,
    inheritedQuoted?: boolean,
    hereDocument?: boolean,
  ): ShellWord;
  protected abstract readArithmeticCommand(): Token;
  protected abstract readPendingHereDocuments(): void;
  protected abstract readBacktickSubstitution(): ScriptNode;
  protected abstract readCommandSubstitution(): ScriptNode;
  protected abstract readArithmeticExpansion(): import("./arithmetic.js").ArithmeticNode;
  protected abstract expansionWord(
    source: string,
    baseByteOffset: number,
    depth: number,
  ): ShellWord;

  lex(): Token[] {
    while (this.offset < this.source.length) this.readToken();
    if (this.expectedHereDocument !== undefined) {
      throw this.error("here-document redirection requires a delimiter", this.source.length);
    }
    if (this.pendingHereDocuments.length > 0) this.readPendingHereDocuments();
    return this.tokens;
  }

  private skipComment(): void {
    while (this.offset < this.source.length && this.source[this.offset] !== "\n") {
      this.checkOffset(this.offset);
      this.offset += 1;
    }
  }

  private readOperatorToken(): boolean {
    const operator = operatorAt(this.source, this.offset, true);
    if (operator === null) return false;
    const token: OperatorToken = {
      type: "operator",
      value: operator,
      offset: this.absoluteOffset(this.offset),
    };
    this.tokens.push(token);
    this.offset += operator.length;
    if (HEREDOC_REDIRECTIONS.has(operator)) this.expectedHereDocument = token;
    if (operator === "\n") this.readPendingHereDocuments();
    return true;
  }

  private readToken(): void {
    this.checkOffset(this.offset);
    const character = this.source[this.offset];
    if (character === undefined) return;
    if (isHorizontalWhitespace(character)) {
      this.offset += 1;
      return;
    }
    if (character === "#") {
      this.skipComment();
      return;
    }
    if (this.source.startsWith("((", this.offset)) {
      this.tokens.push(this.readArithmeticCommand());
      return;
    }
    if (this.source.startsWith("1>&2", this.offset) && isBoundary(this.source[this.offset + 4])) {
      this.offset += 1;
      return;
    }
    if (
      this.source.startsWith("2>&", this.offset) &&
      operatorAt(this.source, this.offset, true) === null
    ) {
      throw this.error(
        "arbitrary file descriptors are not supported by this language version",
        this.offset,
      );
    }
    if (!this.readOperatorToken()) this.readWordToken();
  }

  private readWordToken(): void {
    const word = this.readWord(this.expectedHereDocument !== undefined);
    this.tokens.push({ type: "word", word });
    if (this.expectedHereDocument === undefined) return;
    const delimiter = literalWordValue(word);
    this.pendingHereDocuments.push({
      token: this.expectedHereDocument,
      delimiter: delimiter.value,
      quoted: delimiter.quoted,
      stripTabs: this.expectedHereDocument.value === "<<-",
    });
    this.expectedHereDocument = undefined;
  }

  standaloneWord(inheritedQuoted: boolean): ShellWord {
    return this.readWord(false, false, inheritedQuoted);
  }

  standaloneHereDocumentWord(): ShellWord {
    return this.readWord(false, false, true, true);
  }

  protected absoluteOffset(offset: number): number {
    return this.baseByteOffset + utf8ByteOffset(this.source, this.byteOffsets, offset);
  }

  protected checkOffset(offset: number): void {
    if ((offset & 0xfff) === 0) this.context.checkDeadline();
  }

  protected error(message: string, offset: number): VfsError {
    return new VfsError("EINVAL", `${message} at byte ${this.absoluteOffset(offset)}`);
  }

  protected incompleteError(message: string, offset: number): VfsError {
    return incompleteShellSyntaxError(`${message} at byte ${this.absoluteOffset(offset)}`);
  }

  protected parseArithmetic(
    source: string,
    sourceOffset: number,
  ): ReturnType<typeof parseArithmetic> {
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

  protected append(parts: WordPart[], part: WordPart): void {
    const previous = parts.at(-1);
    if (
      part.kind === "literal" &&
      previous?.kind === "literal" &&
      previous.quoted === part.quoted
    ) {
      previous.value += part.value;
    } else parts.push(part);
  }
}
