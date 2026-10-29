import { VfsError } from "../../core/errors.js";

/**
 * `grep -P` as a translation into the extended dialect, for the part of PCRE
 * that means the same thing there: the shorthand classes, character escapes,
 * `(?:…)`, and a leading `(?i)`.
 *
 * What PCRE alone can express — lookaround, back-references, lazy and
 * possessive quantifiers, `\b` and the other assertions — is refused where it
 * is written instead of approximated. PCRE takes the first alternative that
 * matches where POSIX takes the longest, so a pattern with `|` is refused under
 * `-o`, the one mode where the two can print different text.
 */

export interface PerlPattern {
  readonly source: string;
  readonly ignoreCase: boolean;
}

function refuse(detail: string): never {
  throw new VfsError("EINVAL", `grep: -P does not support ${detail}`);
}

const SHORTHAND: Readonly<Record<string, string>> = {
  d: "[:digit:]",
  w: "[:alnum:]_",
  s: "[:space:]",
};

const CONTROL: Readonly<Record<string, string>> = {
  t: "\t",
  n: "\n",
  r: "\r",
  f: "\f",
  v: "\v",
  a: "\u0007",
  e: "\u001b",
};

/** Characters the extended dialect gives a meaning, escaped when they stand for themselves. */
const ERE_SPECIAL = new Set([..."\\.[]()*+?{}|^$"]);

interface BracketMembers {
  readonly items: string[];
  closeBracket: boolean;
  dash: boolean;
}

function bracketSource(negated: boolean, members: BracketMembers): string {
  const { items, closeBracket, dash } = members;
  const body = `${closeBracket ? "]" : ""}${items.join("")}${dash ? "-" : ""}`;
  if (body === "") refuse("an empty bracket expression");
  // A member `^` must not come first, where it would negate; alone it is a literal.
  if (body === "^") return negated ? "[^^]" : "\\^";
  const ordered = body.startsWith("^") ? `${body.slice(1)}^` : body;
  return `[${negated ? "^" : ""}${ordered}]`;
}

class Translator {
  private index = 0;
  private readonly points: readonly string[];
  private alternation = false;

  constructor(pattern: string) {
    this.points = [...pattern];
  }

  translate(onlyMatching: boolean): PerlPattern {
    let ignoreCase = false;
    if (this.points.slice(0, 4).join("") === "(?i)") {
      ignoreCase = true;
      this.index = 4;
    }
    let source = "";
    while (this.index < this.points.length) source += this.atom();
    if (onlyMatching && this.alternation) {
      refuse("| with -o: PCRE prints the first alternative that matches, POSIX the longest");
    }
    return { source, ignoreCase };
  }

  private at(offset = 0): string | undefined {
    return this.points[this.index + offset];
  }

  private atom(): string {
    const character = this.at() ?? "";
    if (character === "\\") return this.escape(false);
    if (character === "[") return this.bracket();
    if (character === "(") return this.group();
    if (character === "|") this.alternation = true;
    this.index += 1;
    if ("*+?}".includes(character)) this.quantifierSuffix();
    return character;
  }

  /** `*?`, `*+` and the like after a quantifier change its meaning in PCRE. */
  private quantifierSuffix(): void {
    const next = this.at();
    if (next === "?") refuse("lazy quantifiers");
    if (next === "+") refuse("possessive quantifiers");
  }

  private group(): string {
    if (this.at(1) !== "?") {
      this.index += 1;
      return "(";
    }
    if (this.at(2) === ":") {
      this.index += 3;
      return "(";
    }
    const kind = this.at(2) ?? "";
    if ("=!<".includes(kind)) refuse("lookaround");
    return refuse(`(?${kind}`);
  }

  /** The literal `character`, escaped where the extended dialect would read it as syntax. */
  private static literal(character: string, inBracket: boolean): string {
    if (inBracket) return character;
    return ERE_SPECIAL.has(character) ? `\\${character}` : character;
  }

  private hex(): string {
    // `\xHH` or `\x{H…}`, after the `\x` has been consumed.
    if (this.at() === "{") {
      let close = this.index + 1;
      while (close < this.points.length && this.points[close] !== "}") close += 1;
      const digits = this.points.slice(this.index + 1, close).join("");
      if (close >= this.points.length || !/^[0-9A-Fa-f]{1,6}$/u.test(digits)) {
        refuse(`\\x{${digits}`);
      }
      this.index = close + 1;
      return String.fromCodePoint(Number.parseInt(digits, 16));
    }
    let digits = "";
    while (digits.length < 2 && /[0-9A-Fa-f]/u.test(this.at() ?? "")) {
      digits += this.at();
      this.index += 1;
    }
    return String.fromCodePoint(digits === "" ? 0 : Number.parseInt(digits, 16));
  }

  /** One escape; inside a bracket expression a class becomes its bracket form. */
  private escape(inBracket: boolean): string {
    const next = this.at(1);
    if (next === undefined) refuse("a trailing backslash");
    this.index += 2;
    const shorthand = SHORTHAND[next.toLowerCase()];
    if (shorthand !== undefined) {
      const negated = next !== next.toLowerCase();
      if (inBracket) {
        if (negated) refuse(`\\${next} inside a bracket expression`);
        return shorthand;
      }
      return `[${negated ? "^" : ""}${shorthand}]`;
    }
    const control = CONTROL[next];
    if (control !== undefined) return Translator.literal(control, inBracket);
    if (next === "x") return Translator.literal(this.hex(), inBracket);
    if (/[A-Za-z0-9]/u.test(next)) refuse(`\\${next}`);
    // Any other escaped character stands for itself.
    return Translator.literal(next, inBracket);
  }

  /**
   * A bracket expression, rebuilt in POSIX form: PCRE escapes there, POSIX
   * does not, so `]` goes first and `-` last when they are literal.
   */
  private bracket(): string {
    this.index += 1;
    const negated = this.at() === "^";
    if (negated) this.index += 1;
    const members: BracketMembers = { items: [], closeBracket: false, dash: false };
    for (let first = true; ; first = false) {
      const character = this.at();
      if (character === undefined) refuse("an unterminated [");
      if (character === "]" && !first) break;
      this.bracketMember(character, members);
    }
    this.index += 1;
    return bracketSource(negated, members);
  }

  private bracketMember(character: string, members: BracketMembers): void {
    if (character === "[" && this.at(1) === ":") {
      members.items.push(this.posixClass());
      return;
    }
    const item = character === "\\" ? this.escape(true) : this.take();
    const literalDash = character === "\\" || this.at() === "]" || members.items.length === 0;
    if (item === "]") members.closeBracket = true;
    else if (item === "-" && literalDash) members.dash = true;
    else members.items.push(item);
  }

  private posixClass(): string {
    const close = this.points.indexOf(":", this.index + 2);
    if (close < 0 || this.points[close + 1] !== "]") refuse("an unterminated [:");
    const text = this.points.slice(this.index, close + 2).join("");
    this.index = close + 2;
    return text;
  }

  private take(): string {
    const character = this.at() ?? "";
    this.index += 1;
    return character;
  }
}

export function perlPattern(pattern: string, onlyMatching: boolean): PerlPattern {
  return new Translator(pattern).translate(onlyMatching);
}
