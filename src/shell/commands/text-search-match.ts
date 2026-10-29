import { VfsError } from "../../core/errors.js";
import { compilePosixRegex, type PosixRegex } from "../../core/posix-regex.js";
import { utf8ByteLength } from "../../core/unicode.js";
import { perlPattern } from "./text-search-pcre.js";

export interface GrepMatchOptions {
  readonly fixed: boolean;
  readonly extended: boolean;
  /** `-P`: the PCRE subset `text-search-pcre.ts` translates into the extended dialect. */
  readonly perl: boolean;
  /** `-o`, under which `-P` refuses alternation. */
  readonly onlyMatching: boolean;
  readonly ignoreCase: boolean;
  /** `-x`: a match must be the whole line. */
  readonly line: boolean;
  /** `-w`: a match must not touch a word character on either side. */
  readonly word: boolean;
}

interface Span {
  readonly index: number;
  readonly end: number;
}

interface CompiledPattern {
  readonly regex: PosixRegex | undefined;
  readonly needle: string;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

const WORD = /[A-Za-z0-9_]/u;

/**
 * `-x` anchors the whole pattern as one group, so an alternation must cover
 * the line rather than only its first branch.
 */
function wholeLinePattern(pattern: string, extended: boolean): string {
  return extended ? `^(${pattern})$` : `^\\(${pattern}\\)$`;
}

/**
 * Every pattern `grep` was given, as one matcher. A line is selected when any
 * pattern matches it under `-x` or `-w`; `-o` prints the non-overlapping
 * matches of all patterns left to right.
 */
export class GrepMatcher {
  private readonly patterns: readonly CompiledPattern[];

  constructor(
    patterns: readonly string[],
    private readonly options: GrepMatchOptions,
  ) {
    this.patterns = patterns.map((pattern) => this.compile(pattern));
  }

  selects(line: string): boolean {
    if (!this.options.word) {
      return this.patterns.some((pattern) =>
        pattern.regex === undefined
          ? this.fixedSelects(pattern.needle, line)
          : pattern.regex.test(line),
      );
    }
    return this.patterns.some((pattern) => this.spans(pattern, line).next().done === false);
  }

  /** The matched parts of a line, left to right without overlap. */
  parts(line: string): string[] {
    const spans = this.patterns
      .flatMap((pattern) => [...this.spans(pattern, line)])
      .filter((span) => span.end > span.index)
      .sort((left, right) => left.index - right.index || right.end - left.end);
    const parts: string[] = [];
    let covered = -1;
    for (const span of spans) {
      if (span.index < covered) continue;
      parts.push(line.slice(span.index, span.end));
      covered = span.end;
    }
    return parts;
  }

  private compile(pattern: string): CompiledPattern {
    if (utf8ByteLength(pattern) > 4096) throw new VfsError("E2BIG", "grep pattern is too large");
    const { fixed, perl, line } = this.options;
    if (fixed) {
      return { regex: undefined, needle: this.options.ignoreCase ? asciiLower(pattern) : pattern };
    }
    const translated = perl ? perlPattern(pattern, this.options.onlyMatching) : undefined;
    const extended = perl || this.options.extended;
    const ignoreCase = this.options.ignoreCase || translated?.ignoreCase === true;
    const body = translated?.source ?? pattern;
    const source = line ? wholeLinePattern(body, extended) : body;
    return {
      regex: compilePosixRegex(source, extended ? "extended" : "basic", "grep", {
        ...(ignoreCase ? { ignoreCase: true } : {}),
      }),
      needle: pattern,
    };
  }

  private fixedSelects(needle: string, line: string): boolean {
    const text = this.options.ignoreCase ? asciiLower(line) : line;
    return this.options.line ? text === needle : text.includes(needle);
  }

  private wordBounded(line: string, span: Span): boolean {
    if (!this.options.word) return true;
    return !WORD.test(line[span.index - 1] ?? "") && !WORD.test(line[span.end] ?? "");
  }

  /** Candidate matches from every starting point, keeping those `-w` accepts. */
  private *spans(pattern: CompiledPattern, line: string): Generator<Span> {
    for (let from = 0; from <= line.length; ) {
      const span = this.find(pattern, line, from);
      if (span === undefined) return;
      if (this.wordBounded(line, span)) {
        yield span;
        from = span.end > span.index ? span.end : span.index + 1;
      } else from = span.index + 1;
    }
  }

  private find(pattern: CompiledPattern, line: string, from: number): Span | undefined {
    if (pattern.regex !== undefined) return pattern.regex.exec(line, from);
    const text = this.options.ignoreCase ? asciiLower(line) : line;
    if (this.options.line)
      return from === 0 && text === pattern.needle ? { index: 0, end: line.length } : undefined;
    if (pattern.needle === "") return from <= line.length ? { index: from, end: from } : undefined;
    const index = text.indexOf(pattern.needle, from);
    return index < 0 ? undefined : { index, end: index + pattern.needle.length };
  }
}
