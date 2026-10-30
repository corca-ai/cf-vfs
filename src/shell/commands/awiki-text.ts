/**
 * Text primitives for `awiki`, with the semantics of the Rust implementation
 * it follows: Unicode `White_Space` trimming (not JavaScript's, which also
 * strips U+FEFF), code point string order, and round-half-even decimals.
 */

const LETTER_OR_DIGIT = /[\p{Alphabetic}\p{N}]/u;

/**
 * Unicode `White_Space`, which Rust's `char::is_whitespace` tests. Every
 * member is in the Basic Multilingual Plane, so one code unit decides; the
 * regular expressions this replaces dominated parsing a large wiki.
 */
function isSpaceCode(code: number): boolean {
  if (code < 0x80) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return (
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

export function isWhiteSpace(character: string): boolean {
  return character.length === 1 && isSpaceCode(character.charCodeAt(0));
}

export function isLetterOrDigit(character: string): boolean {
  return LETTER_OR_DIGIT.test(character);
}

export function trim(value: string): string {
  return trimEnd(trimStart(value));
}

export function trimStart(value: string): string {
  let start = 0;
  while (start < value.length && isSpaceCode(value.charCodeAt(start))) start += 1;
  return start === 0 ? value : value.slice(start);
}

export function trimEnd(value: string): string {
  let end = value.length;
  while (end > 0 && isSpaceCode(value.charCodeAt(end - 1))) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

export function splitWhitespace(value: string): string[] {
  const words: string[] = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const space = index === value.length || isSpaceCode(value.charCodeAt(index));
    if (space && start >= 0) {
      words.push(value.slice(start, index));
      start = -1;
    } else if (!space && start < 0) {
      start = index;
    }
  }
  return words;
}

/** `[ \t\n\f\r]`, Rust's `is_ascii_whitespace`. */
export function isAsciiWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r"
  );
}

export interface ScannedLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Lines with their terminating newline, as the Rust `scan_lines`. */
export function scanLines(content: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline + 1;
    lines.push({ text: content.slice(start, end), start, end });
    start = end;
  }
  return lines;
}

/** Removes trailing `\r` and `\n` characters. */
export function trimLine(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === "\n" || line[end - 1] === "\r")) end -= 1;
  return line.slice(0, end);
}

/** Whitespace runs collapsed to single spaces, without the outer ones. */
export function normalizePreviewLine(line: string): string {
  return normalizeCounting(line).text;
}

/**
 * The normalized line and its word count in one pass. A line that already has
 * single spaces between words, as prose mostly does, is returned as it is.
 */
export function normalizeCounting(line: string): { text: string; words: number } {
  let previousSpace = true;
  let spaces = 0;
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    const space = code === 0x20;
    if ((space && previousSpace) || (!space && isSpaceCode(code))) {
      const words = splitWhitespace(line);
      return { text: words.join(" "), words: words.length };
    }
    if (space) spaces += 1;
    previousSpace = space;
  }
  if (line.length > 0 && previousSpace) {
    const words = splitWhitespace(line);
    return { text: words.join(" "), words: words.length };
  }
  return { text: line, words: line.length === 0 ? 0 : spaces + 1 };
}

function backtickRunEnd(line: string, index: number): number {
  let end = index;
  while (line[end] === "`") end += 1;
  return end;
}

/** Blanks the contents of inline code spans, keeping every offset. */
export function maskInlineCode(line: string): string {
  if (!line.includes("`")) return line;
  let out = "";
  let last = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    const contentStart = backtickRunEnd(line, index);
    const width = contentStart - index;
    let position = contentStart;
    let closed = false;
    while (position < line.length) {
      if (line[position] !== "`") {
        position += 1;
        continue;
      }
      const runStart = position;
      position = backtickRunEnd(line, position);
      if (position - runStart === width) {
        out += line.slice(last, contentStart) + " ".repeat(runStart - contentStart);
        last = runStart;
        index = position;
        closed = true;
        break;
      }
    }
    if (!closed) index = contentStart;
  }
  return out + line.slice(last);
}

interface Fence {
  readonly marker: string;
  readonly width: number;
}

function fenceStart(line: string): Fence | undefined {
  for (const marker of ["`", "~"]) {
    if (line.startsWith(marker.repeat(3))) {
      let width = 0;
      while (line[width] === marker) width += 1;
      return { marker, width };
    }
  }
  return undefined;
}

/** Tracks fenced code blocks line by line. */
export class FenceState {
  inside = false;
  private marker = "";
  private width = 0;

  /** Feeds one trimmed line; true when the line is a fence and must be skipped. */
  fence(trimmed: string): boolean {
    const fence = fenceStart(trimmed);
    if (fence === undefined) return false;
    if (this.inside && fence.marker === this.marker && fence.width >= this.width) {
      this.inside = false;
    } else if (!this.inside) {
      this.inside = true;
      this.marker = fence.marker;
      this.width = fence.width;
    }
    return true;
  }
}

export function startsIndented(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
}

export function lower(value: string): string {
  return value.toLowerCase();
}

/** Unicode code point order, which UTF-8 byte order also gives. */
export function compareText(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.charCodeAt(index);
    const y = b.charCodeAt(index);
    if (x !== y) return codeUnitRank(x) - codeUnitRank(y);
  }
  return a.length - b.length;
}

function codeUnitRank(unit: number): number {
  if (unit >= 0xe000) return unit - 0x800;
  if (unit >= 0xd800) return unit + 0x2000;
  return unit;
}

export function compareLower(a: string, b: string): number {
  return compareText(lower(a), lower(b));
}

export function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export function truncateRunes(value: string, limit: number): string {
  const characters = [...value];
  if (characters.length <= limit) return value;
  if (limit <= 3) return ".".repeat(limit);
  return `${trim(characters.slice(0, limit - 3).join(""))}...`;
}

function stripOrderedListPrefix(value: string): string | undefined {
  let index = 0;
  while (/[0-9]/u.test(value.charAt(index))) index += 1;
  if (
    index > 0 &&
    index + 1 < value.length &&
    (value[index] === "." || value[index] === ")") &&
    isAsciiWhitespace(value[index + 1])
  ) {
    return value.slice(index + 2);
  }
  return undefined;
}

function stripLinePrefixes(value: string): string {
  let next = trim(value);
  if (next.startsWith(">")) next = trim(next.slice(1));
  if (next.length >= 2 && "-*+".includes(next.charAt(0)) && isAsciiWhitespace(next[1])) {
    next = trim(next.slice(2));
  }
  const ordered = stripOrderedListPrefix(next);
  if (ordered !== undefined) next = trim(ordered);
  if (
    next.length >= 4 &&
    next[0] === "[" &&
    next[2] === "]" &&
    isAsciiWhitespace(next[3]) &&
    " xX".includes(next.charAt(1))
  ) {
    next = trim(next.slice(4));
  }
  let hashes = 0;
  while (next[hashes] === "#") hashes += 1;
  if (hashes >= 1 && hashes <= 6 && (next.length === hashes || isAsciiWhitespace(next[hashes]))) {
    next = trim(next.slice(hashes));
  }
  return next;
}

/** Strips quote, list, task and heading markers until nothing changes. */
export function stripLineOnlyMarkdown(value: string): string {
  let current = trim(value);
  for (;;) {
    const before = current;
    current = stripLinePrefixes(current);
    if (current === trim(before)) return current;
  }
}

export function containsLetterOrDigit(value: string): boolean {
  for (const character of value) if (isLetterOrDigit(character)) return true;
  return false;
}

/**
 * `value` with `digits` decimals, rounding an exact tie to even as Rust's
 * formatter does; `toFixed` rounds it up.
 */
export function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  if (!Number.isFinite(value)) return text;
  const scaled = exactScaled(Math.abs(value), digits);
  if (scaled === undefined) return text;
  const { whole, remainder, denominator } = scaled;
  const twice = remainder * 2n;
  const rounded =
    twice > denominator || (twice === denominator && whole % 2n === 1n) ? whole + 1n : whole;
  const sign = value < 0 ? "-" : "";
  const raw = rounded.toString().padStart(digits + 1, "0");
  const integer = raw.slice(0, raw.length - digits);
  const fraction = raw.slice(raw.length - digits);
  return `${sign}${integer}${digits > 0 ? `.${fraction}` : ""}`;
}

/** `value * 10^digits` as an exact quotient and remainder over a power of two. */
function exactScaled(
  value: number,
  digits: number,
): { whole: bigint; remainder: bigint; denominator: bigint } | undefined {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exponent: number;
  if (exponentBits === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  const numerator = mantissa * 10n ** BigInt(digits);
  if (exponent >= 0)
    return { whole: numerator << BigInt(exponent), remainder: 0n, denominator: 1n };
  const denominator = 1n << BigInt(-exponent);
  return { whole: numerator / denominator, remainder: numerator % denominator, denominator };
}

/** A string as Rust's `{:?}` prints it. */
const DEBUG_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0",
};

export function debugQuote(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : character;
    out += DEBUG_ESCAPES[character] ?? control;
  }
  return `${out}"`;
}
