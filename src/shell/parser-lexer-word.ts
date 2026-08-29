import type { ParameterExpansion, ShellWord, WordPart } from "./parser-ast.js";
import { ShellLexerBase } from "./parser-lexer-base.js";
import {
  assignmentName,
  isHorizontalWhitespace,
  operatorAt,
  topLevelDelimiters,
} from "./parser-support.js";

const DEFAULT_OPERATORS = [":-", ":=", ":+", ":?", "-", "=", "+", "?"] as const;
const REMOVAL_OPERATORS = ["##", "%%", "#", "%"] as const;

export abstract class ShellWordLexer extends ShellLexerBase {
  private wordEnded(stopAtWhitespace: boolean, parts: readonly WordPart[]): boolean {
    const character = this.source[this.offset];
    if (character === undefined) return true;
    if (!stopAtWhitespace) return false;
    if (isHorizontalWhitespace(character) || character === "\n") return true;
    return operatorAt(this.source, this.offset, parts.length === 0) !== null;
  }

  private readSingleQuoted(parts: WordPart[]): void {
    const quote = this.offset++;
    let value = "";
    while (this.offset < this.source.length && this.source[this.offset] !== "'") {
      this.checkOffset(this.offset);
      value += this.source[this.offset++] ?? "";
    }
    if (this.source[this.offset] !== "'") {
      throw this.incompleteError("unterminated single quote", quote);
    }
    this.offset += 1;
    this.append(parts, { kind: "literal", value, quoted: true });
  }

  private readEscaped(parts: WordPart[], literalQuotes: boolean): void {
    const next = this.source[this.offset + 1];
    if (next === undefined) throw this.incompleteError("unterminated escape", this.offset);
    this.offset += 2;
    if (next === "\n") return;
    const value =
      literalQuotes && next !== "$" && next !== "\\" && next !== "`" ? `\\${next}` : next;
    this.append(parts, { kind: "literal", value, quoted: true });
  }

  private readDollar(parts: WordPart[], inheritedQuoted: boolean): boolean {
    const next = this.source[this.offset + 1];
    if (next === "'" || next === '"') {
      throw this.error(
        "locale and ANSI-C quotes are not supported by this language version",
        this.offset,
      );
    }
    const expansion = this.readExpansion(inheritedQuoted);
    if (expansion === undefined) return false;
    this.append(parts, expansion);
    return true;
  }

  private readSpecialPart(
    parts: WordPart[],
    character: string,
    delimiterMode: boolean,
    inheritedQuoted: boolean,
    literalQuotes: boolean,
  ): boolean {
    if (literalQuotes && (character === "'" || character === '"')) {
      this.append(parts, { kind: "literal", value: character, quoted: true });
      this.offset += 1;
    } else if (character === "'") this.readSingleQuoted(parts);
    else if (character === '"') this.readDoubleQuoted(parts, delimiterMode);
    else if (character === "\\") this.readEscaped(parts, literalQuotes);
    else if (character === "`" && !delimiterMode) {
      this.append(parts, {
        kind: "command",
        script: this.readBacktickSubstitution(),
        quoted: inheritedQuoted,
      });
    } else if (character === "$" && !delimiterMode) return this.readDollar(parts, inheritedQuoted);
    else return false;
    return true;
  }

  private rejectAdjacentDescriptor(parts: readonly WordPart[], start: number): void {
    const unquoted = parts.every((part) => part.kind === "literal" && !part.quoted)
      ? parts.map((part) => (part.kind === "literal" ? part.value : "")).join("")
      : undefined;
    const adjacent = operatorAt(this.source, this.offset, false);
    if (
      unquoted !== undefined &&
      /^[0-9]+$/u.test(unquoted) &&
      (adjacent === "<" || adjacent === ">" || adjacent === ">>")
    ) {
      throw this.error(
        "arbitrary file descriptors are not supported by this language version",
        start,
      );
    }
  }

  protected readWord(
    delimiterMode: boolean,
    stopAtWhitespace = true,
    inheritedQuoted = false,
    literalQuotes = false,
  ): ShellWord {
    const start = this.offset;
    const parts: WordPart[] = [];
    while (!this.wordEnded(stopAtWhitespace, parts)) {
      this.checkOffset(this.offset);
      const character = this.source[this.offset] ?? "";
      if (this.readSpecialPart(parts, character, delimiterMode, inheritedQuoted, literalQuotes))
        continue;
      this.append(parts, { kind: "literal", value: character, quoted: inheritedQuoted });
      this.offset += 1;
    }
    if (parts.length === 0) throw this.error("expected word", start);
    this.rejectAdjacentDescriptor(parts, start);
    const name = assignmentName(parts);
    return {
      parts,
      sourceOffset: this.absoluteOffset(start),
      ...(name === undefined ? {} : { assignmentName: name }),
    };
  }

  private readDoubleQuotedEscape(parts: WordPart[]): void {
    const next = this.source[this.offset + 1];
    if (next === undefined) throw this.incompleteError("unterminated escape", this.offset);
    this.offset += 2;
    if (next === "$" || next === '"' || next === "\\" || next === "\n") {
      if (next !== "\n") this.append(parts, { kind: "literal", value: next, quoted: true });
    } else this.append(parts, { kind: "literal", value: `\\${next}`, quoted: true });
  }

  private readDoubleQuotedSpecial(
    parts: WordPart[],
    character: string | undefined,
    delimiterMode: boolean,
  ): boolean {
    if (character === "\\") this.readDoubleQuotedEscape(parts);
    else if (character === "`" && !delimiterMode) {
      this.append(parts, {
        kind: "command",
        script: this.readBacktickSubstitution(),
        quoted: true,
      });
    } else if (character === "$" && !delimiterMode) {
      const expansion = this.readExpansion(true);
      if (expansion === undefined) return false;
      this.append(parts, expansion);
    } else return false;
    return true;
  }

  private readDoubleQuoted(parts: WordPart[], delimiterMode: boolean): void {
    const start = this.offset++;
    const before = parts.length;
    while (this.offset < this.source.length && this.source[this.offset] !== '"') {
      this.checkOffset(this.offset);
      const character = this.source[this.offset];
      if (this.readDoubleQuotedSpecial(parts, character, delimiterMode)) continue;
      this.append(parts, { kind: "literal", value: character ?? "", quoted: true });
      this.offset += 1;
    }
    if (this.source[this.offset] !== '"') {
      throw this.incompleteError("unterminated double quote", start);
    }
    this.offset += 1;
    if (parts.length === before) this.append(parts, { kind: "literal", value: "", quoted: true });
  }

  private readParenthesizedExpansion(quoted: boolean): WordPart {
    if (this.source[this.offset + 2] === "(") {
      return { kind: "arithmetic", expression: this.readArithmeticExpansion(), quoted };
    }
    return { kind: "command", script: this.readCommandSubstitution(), quoted };
  }

  private readSimpleParameter(next: string, quoted: boolean): WordPart {
    this.offset += 2;
    let name = next;
    if (/[A-Za-z_]/u.test(next)) {
      const suffix = /^[A-Za-z0-9_]*/u.exec(this.source.slice(this.offset))?.[0] ?? "";
      name += suffix;
      this.offset += suffix.length;
    }
    return { kind: "parameter", expansion: { name, length: false }, quoted };
  }

  private readExpansion(quoted: boolean): WordPart | undefined {
    const start = this.offset;
    const next = this.source[this.offset + 1];
    if (next === "(") return this.readParenthesizedExpansion(quoted);
    if (next === "{") {
      const expansion = this.readBracedParameter();
      return { kind: "parameter", expansion, quoted };
    }
    if (next !== undefined && /[A-Za-z_?#@*0-9-]/u.test(next))
      return this.readSimpleParameter(next, quoted);
    if (next === "$") {
      throw this.error("special parameter is not supported by this language version", start);
    }
    return undefined;
  }

  private readIndirectParameter(start: number): ParameterExpansion {
    this.offset += 1;
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.source.slice(this.offset))?.[0];
    if (name === undefined) throw this.error("invalid indirect parameter expansion", start);
    this.offset += name.length;
    if (this.source[this.offset] !== "}") {
      throw this.error("unsupported indirect parameter expansion", this.offset);
    }
    this.offset += 1;
    return { kind: "indirect", name, length: false };
  }

  private readDefaultParameter(
    name: string,
    operator: (typeof DEFAULT_OPERATORS)[number],
  ): ParameterExpansion {
    this.offset += operator.length;
    const operandStart = this.offset;
    const close = this.findParameterClose();
    const word = this.expansionWord(
      this.source.slice(operandStart, close),
      this.absoluteOffset(operandStart),
      this.depth + 1,
    );
    this.offset = close + 1;
    return { name, length: false, operator, word };
  }

  private readRemovalParameter(
    name: string,
    removalOperator: (typeof REMOVAL_OPERATORS)[number],
  ): ParameterExpansion {
    this.offset += removalOperator.length;
    const patternStart = this.offset;
    const close = this.findParameterClose();
    const pattern = this.expansionWord(
      this.source.slice(patternStart, close),
      this.absoluteOffset(patternStart),
      this.depth + 1,
    );
    this.offset = close + 1;
    return { kind: "remove", name, length: false, removalOperator, pattern };
  }

  private readReplacementParameter(name: string): ParameterExpansion {
    const all = this.source[this.offset + 1] === "/";
    this.offset += all ? 2 : 1;
    const patternStart = this.offset;
    const close = this.findParameterClose();
    const contents = this.source.slice(patternStart, close);
    const separator = topLevelDelimiters(contents, "/", () => this.context.checkDeadline())[0];
    const patternSource = separator === undefined ? contents : contents.slice(0, separator);
    const replacementSource = separator === undefined ? "" : contents.slice(separator + 1);
    if (patternSource.startsWith("#") || patternSource.startsWith("%")) {
      throw this.error("anchored parameter replacement is not supported", patternStart);
    }
    const pattern = this.expansionWord(
      patternSource,
      this.absoluteOffset(patternStart),
      this.depth + 1,
    );
    const replacementStart =
      patternStart + (separator ?? contents.length) + (separator === undefined ? 0 : 1);
    const replacement = this.expansionWord(
      replacementSource,
      this.absoluteOffset(replacementStart),
      this.depth + 1,
    );
    this.offset = close + 1;
    return { kind: "replace", name, length: false, all, pattern, replacement };
  }

  private readSubstringParameter(name: string): ParameterExpansion {
    this.offset += 1;
    const offsetStart = this.offset;
    const close = this.findParameterClose();
    const contents = this.source.slice(offsetStart, close);
    const separators = topLevelDelimiters(contents, ":", () => this.context.checkDeadline());
    if (separators.length > 1) {
      throw this.error("substring expansion accepts at most one length", offsetStart);
    }
    const separator = separators[0];
    const offsetSource = separator === undefined ? contents : contents.slice(0, separator);
    const lengthSource = separator === undefined ? undefined : contents.slice(separator + 1);
    if (offsetSource.trim().length === 0 || lengthSource?.trim().length === 0) {
      throw this.error("substring offset and length must not be empty", offsetStart);
    }
    const offset = this.expansionWord(
      offsetSource,
      this.absoluteOffset(offsetStart),
      this.depth + 1,
    );
    const lengthStart = offsetStart + (separator ?? contents.length) + 1;
    const substringLength =
      lengthSource === undefined
        ? undefined
        : this.expansionWord(lengthSource, this.absoluteOffset(lengthStart), this.depth + 1);
    this.offset = close + 1;
    return {
      kind: "substring",
      name,
      length: false,
      offset,
      ...(substringLength === undefined ? {} : { substringLength }),
    };
  }

  private readBracedParameter(): ParameterExpansion {
    const start = this.offset;
    this.offset += 2;
    if (this.source[this.offset] === "!") return this.readIndirectParameter(start);
    let length = false;
    if (this.source[this.offset] === "#") {
      length = true;
      this.offset += 1;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[?#@*-]|[0-9]+)/u.exec(
      this.source.slice(this.offset),
    )?.[0];
    if (name === undefined) throw this.error("invalid parameter expansion", start);
    this.offset += name.length;
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return { name, length };
    }
    if (length) throw this.error("parameter length expansion does not accept an operator", start);
    const operator = DEFAULT_OPERATORS.find((candidate) =>
      this.source.startsWith(candidate, this.offset),
    );
    if (operator !== undefined) return this.readDefaultParameter(name, operator);
    if (name === "@") {
      throw this.error("array-style parameter operations are not supported", start);
    }
    const removal = REMOVAL_OPERATORS.find((candidate) =>
      this.source.startsWith(candidate, this.offset),
    );
    if (removal !== undefined) return this.readRemovalParameter(name, removal);
    if (this.source[this.offset] === "/") return this.readReplacementParameter(name);
    if (this.source[this.offset] === ":") return this.readSubstringParameter(name);
    throw this.error("unsupported parameter expansion operator", this.offset);
  }

  private findParameterClose(): number {
    const close = topLevelDelimiters(
      this.source,
      "}",
      () => this.context.checkDeadline(),
      this.offset,
    )[0];
    if (close !== undefined) return close;
    throw this.incompleteError("unterminated parameter expansion", this.offset);
  }
}
