import { VfsError } from "../core/errors.js";
import type { AndOrNode, ScriptNode, ShellWord } from "./parser-ast.js";
import { incompleteShellSyntaxError } from "./parser-errors.js";
import { type Operator, type ParseContext, staticWord, type Token } from "./parser-support.js";

export interface StopSet {
  words?: ReadonlySet<string>;
  operators?: ReadonlySet<Operator>;
}

export abstract class ParserCursor {
  protected readonly tokens: readonly Token[];
  protected readonly context: ParseContext;
  protected readonly depth: number;
  protected index = 0;

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

  protected abstract andOr(): AndOrNode;

  protected add(): void {
    this.context.add();
  }

  protected peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  protected take(): Token {
    const token = this.tokens[this.index++];
    if (token === undefined) throw incompleteShellSyntaxError("unexpected end of script");
    return token;
  }

  protected isSeparator(token: Token | undefined): boolean {
    return token?.type === "operator" && (token.value === ";" || token.value === "\n");
  }

  protected skipSeparators(): void {
    while (this.isSeparator(this.peek())) this.index += 1;
  }

  protected skipNewlines(): void {
    while (this.peekOperator() === "\n") this.index += 1;
  }

  protected requiredList(
    stop: StopSet,
    description: string,
    requireSeparator: boolean,
  ): ScriptNode {
    const body = this.parse(stop);
    const token = this.peek();
    if (body.lists.length === 0) this.throwEmptyList(description, token);
    if (requireSeparator && token !== undefined && !this.isSeparator(this.tokens[this.index - 1])) {
      throw this.tokenError(`${description} requires a separator before its terminator`, token);
    }
    return body;
  }

  protected tokenError(message: string, token: Token): VfsError {
    const offset = token.type === "word" ? token.word.sourceOffset : token.offset;
    return new VfsError("EINVAL", `${message} at byte ${offset}`);
  }

  protected expectWord(value: string): void {
    const token = this.peek();
    if (token?.type !== "word" || staticWord(token.word) !== value) {
      if (token === undefined)
        throw incompleteShellSyntaxError(`expected ${value} at end of script`);
      throw this.tokenError(`expected ${value}`, token);
    }
    this.index += 1;
  }

  protected expectOperator(value: Operator): void {
    const token = this.peek();
    if (token?.type !== "operator" || token.value !== value) {
      if (token === undefined)
        throw incompleteShellSyntaxError(`expected ${value} at end of script`);
      throw this.tokenError(`expected ${value}`, token);
    }
    this.index += 1;
  }

  protected peekOperator(offset = 0): Operator | undefined {
    const token = this.peek(offset);
    return token?.type === "operator" ? token.value : undefined;
  }

  protected withDepth<T>(run: () => T): T {
    this.context.depth(this.depth + 1);
    return run();
  }

  protected takeWord(): ShellWord {
    const token = this.take();
    if (token.type !== "word") throw this.tokenError("expected word", token);
    return token.word;
  }

  protected peekWord(): ShellWord | undefined {
    const token = this.peek();
    return token?.type === "word" ? token.word : undefined;
  }

  protected takeWordOffset(): number {
    return this.takeWord().sourceOffset;
  }

  private stopped(stop: StopSet): boolean {
    const token = this.peek();
    if (token?.type === "operator") return stop.operators?.has(token.value) === true;
    const word = token?.type === "word" ? staticWord(token.word) : undefined;
    return word !== undefined && stop.words?.has(word) === true;
  }

  private throwEmptyList(description: string, token: Token | undefined): never {
    if (token === undefined) {
      throw incompleteShellSyntaxError(
        `${description} requires a non-empty command list at end of script`,
      );
    }
    throw this.tokenError(`${description} requires a non-empty command list`, token);
  }
}
