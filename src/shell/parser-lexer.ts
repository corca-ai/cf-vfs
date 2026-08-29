import { VfsError } from "../core/errors.js";
import type { ArithmeticNode } from "./arithmetic.js";
import type { ScriptNode, ShellWord } from "./parser-ast.js";
import { isIncompleteShellSyntaxError } from "./parser-errors.js";
import type { NestedParser, PendingHereDocument } from "./parser-lexer-base.js";
import { ShellWordLexer } from "./parser-lexer-word.js";
import { ParseContext, type Token } from "./parser-support.js";

class CommandSubstitutionScanner {
  private depth = 1;
  private quote: "'" | '"' | undefined;

  constructor(private readonly source: string) {}

  advance(index: number): { step: number; candidate: boolean } {
    const character = this.source[index];
    if (character === "\\" && this.quote !== "'") return { step: 2, candidate: false };
    if (this.quote !== undefined) {
      if (character === this.quote) this.quote = undefined;
      return { step: 1, candidate: false };
    }
    if (character === "'" || character === '"') {
      this.quote = character;
      return { step: 1, candidate: false };
    }
    if (character === "(") this.depth += 1;
    else if (character === ")" && this.depth > 1) this.depth -= 1;
    else return { step: 1, candidate: character === ")" };
    return { step: 1, candidate: false };
  }
}

export class Lexer extends ShellWordLexer {
  /**
   * Reads a backtick command substitution, the older spelling of `$(...)`.
   *
   * The closing backtick is found by scanning, not by parsing: quotes do not
   * protect one, and a backslash escapes only `` ` ``, `\`, and `$`. That is
   * why the form nests only through escaping, and why `$(...)` is the spelling
   * to reach for — but it is what a generated script tends to contain, so it
   * runs rather than being refused.
   *
   * Removing those backslashes shifts the offsets the inner parse reports. The
   * shift is the number of escapes removed before the point in question, and is
   * zero for a substitution that contains none.
   */
  protected readBacktickSubstitution(): ScriptNode {
    const start = this.offset;
    let index = start + 1;
    let content = "";
    for (; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "`") break;
      if (character === "\\") {
        const next = this.source[index + 1];
        if (next === "`" || next === "\\" || next === "$") {
          content += next;
          index += 1;
          continue;
        }
      }
      content += character ?? "";
    }
    if (this.source[index] !== "`") {
      throw this.incompleteError("unterminated backtick command substitution", start);
    }
    const probe = new ParseContext(
      this.context.remainingNodes(),
      this.context.maximumDepth,
      () => undefined,
      () => this.context.checkDeadline(),
    );
    const script = this.parseNested(content, probe, this.absoluteOffset(start + 1), this.depth + 1);
    this.context.add(probe.nodes);
    this.offset = index + 1;
    return script;
  }

  protected readCommandSubstitution(): ScriptNode {
    const start = this.offset;
    const contentStart = this.offset + 2;
    let lastSyntaxError: VfsError | undefined;
    const attempted = new Set<number>();
    const accept = (close: number): ScriptNode | undefined => {
      attempted.add(close);
      const probe = new ParseContext(
        this.context.remainingNodes(),
        this.context.maximumDepth,
        () => undefined,
        () => this.context.checkDeadline(),
      );
      try {
        const script = this.parseNested(
          this.source.slice(contentStart, close),
          probe,
          this.absoluteOffset(contentStart),
          this.depth + 1,
        );
        this.context.add(probe.nodes);
        this.offset = close + 1;
        return script;
      } catch (error) {
        if (!(error instanceof VfsError) || error.code !== "EINVAL") throw error;
        lastSyntaxError = isIncompleteShellSyntaxError(error)
          ? new VfsError(error.code, error.message, error.path)
          : error;
        return undefined;
      }
    };

    const scanner = new CommandSubstitutionScanner(this.source);
    for (let index = contentStart; index < this.source.length; ) {
      this.checkOffset(index);
      const scanned = scanner.advance(index);
      if (scanned.candidate) {
        const script = accept(index);
        if (script !== undefined) return script;
      }
      index += scanned.step;
    }

    // Quotes, case patterns, and here-document bodies can contain parentheses
    // that are not shell grouping syntax. Let the actual lexer and parser
    // disambiguate any candidates skipped by the fast balanced scan above.
    for (let index = contentStart; index < this.source.length; index += 1) {
      this.checkOffset(index);
      if (this.source[index] !== ")" || attempted.has(index)) continue;
      const script = accept(index);
      if (script !== undefined) return script;
    }

    if (lastSyntaxError !== undefined) throw lastSyntaxError;
    throw this.incompleteError("unterminated command substitution", start);
  }

  private readArithmeticBody(kind: "expansion" | "command", contentStart: number): ArithmeticNode {
    const start = this.offset;
    let parentheses = 0;
    let index = contentStart;
    for (; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") {
        if (parentheses === 0 && this.source[index + 1] === ")") break;
        parentheses -= 1;
        if (parentheses < 0) throw this.error(`invalid arithmetic ${kind}`, start);
      }
    }
    if (index >= this.source.length) {
      throw this.incompleteError(`unterminated arithmetic ${kind}`, start);
    }
    const parsed = this.parseArithmetic(this.source.slice(contentStart, index), contentStart);
    this.context.add(parsed.nodeCount);
    this.offset = index + 2;
    return parsed.node;
  }

  protected readArithmeticExpansion(): ArithmeticNode {
    return this.readArithmeticBody("expansion", this.offset + 3);
  }

  protected readArithmeticCommand(): Token {
    const start = this.offset;
    return {
      type: "arithmetic-command",
      expression: this.readArithmeticBody("command", this.offset + 2),
      offset: this.absoluteOffset(start),
    };
  }

  protected expansionWord(source: string, baseByteOffset: number, depth: number): ShellWord {
    return parseExpansionWord(source, this.context, baseByteOffset, depth, this.parseNested);
  }

  private readHereDocumentBody(item: PendingHereDocument): string {
    const lines: string[] = [];
    while (this.offset <= this.source.length) {
      this.checkOffset(this.offset);
      const lineStart = this.offset;
      const newline = this.source.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? this.source.length : newline;
      const rawLine = this.source.slice(lineStart, lineEnd);
      const bodyLine = item.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
      this.offset = newline < 0 ? this.source.length : newline + 1;
      if (bodyLine === item.delimiter) return lines.join("");
      lines.push(`${bodyLine}${newline < 0 ? "" : "\n"}`);
      if (newline < 0) break;
    }
    throw this.incompleteError(
      `unterminated here-document (wanted ${item.delimiter})`,
      this.offset,
    );
  }

  private hereDocumentWord(item: PendingHereDocument, body: string): ShellWord {
    if (item.quoted) {
      return {
        parts: [{ kind: "literal", value: body, quoted: true }],
        sourceOffset: item.token.offset,
      };
    }
    return parseHereDocumentWord(
      body,
      this.context,
      item.token.offset,
      this.depth + 1,
      this.parseNested,
    );
  }

  protected readPendingHereDocuments(): void {
    if (this.pendingHereDocuments.length === 0) return;
    for (const item of this.pendingHereDocuments.splice(0)) {
      item.token.document = this.hereDocumentWord(item, this.readHereDocumentBody(item));
    }
  }
}

function parseExpansionWord(
  source: string,
  context: ParseContext,
  baseByteOffset: number,
  depth: number,
  parseNested: NestedParser,
): ShellWord {
  context.depth(depth);
  if (source.length === 0)
    return { parts: [{ kind: "literal", value: "", quoted: false }], sourceOffset: baseByteOffset };
  const lexer = new Lexer(source, context, baseByteOffset, depth, parseNested);
  return lexer.standaloneWord(false);
}

function parseHereDocumentWord(
  source: string,
  context: ParseContext,
  baseByteOffset: number,
  depth: number,
  parseNested: NestedParser,
): ShellWord {
  context.depth(depth);
  if (source.length === 0)
    return { parts: [{ kind: "literal", value: "", quoted: true }], sourceOffset: baseByteOffset };
  const lexer = new Lexer(source, context, baseByteOffset, depth, parseNested);
  return lexer.standaloneHereDocumentWord();
}
