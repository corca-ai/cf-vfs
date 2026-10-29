import {
  compilePosixRegex,
  type PosixRegex,
  type PosixRegexDialect,
} from "../../core/posix-regex.js";
import { type AppletSpecWithOptions, appletUsageError } from "./applet.js";

export const SED = {
  name: "sed",
  usage: "[-Ern] [-i] [-e SCRIPT] [SCRIPT] [FILE...]",
  summary: "edits records with a bounded subset of the sed language",
  options: {
    short: {
      n: { name: "quiet" },
      E: { name: "extended" },
      r: { name: "extended" },
      i: { name: "in-place" },
      e: { name: "expression", argument: true },
    },
    long: {
      quiet: { name: "quiet" },
      "in-place": { name: "in-place" },
      "regexp-extended": { name: "extended" },
      expression: { name: "expression", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<"quiet" | "extended" | "in-place" | "expression">;

/** A record selector, optionally requiring one record of lookahead for `last`. */
export type SedAddress =
  | { readonly kind: "line"; readonly line: number }
  | { readonly kind: "last" }
  | { readonly kind: "regex"; readonly pattern: PosixRegex };

export interface SedSelector {
  readonly start: SedAddress;
  readonly end?: SedAddress;
}

export interface SedSubstitute {
  readonly kind: "s";
  readonly pattern: PosixRegex;
  readonly replacement: string;
  readonly global: boolean;
  readonly print: boolean;
  readonly occurrence: number;
}

interface Selected {
  readonly selector?: SedSelector;
  readonly negated: boolean;
}

/** Commands that take no operand. */
type SedSimpleVerb =
  | "p"
  | "P"
  | "d"
  | "D"
  | "n"
  | "N"
  | "g"
  | "G"
  | "h"
  | "H"
  | "x"
  | "z"
  | "="
  | "q"
  | "Q"
  | "}";

const SIMPLE_VERBS: ReadonlySet<string> = new Set("pPdDnNgGhHxz=qQ");

/**
 * One instruction of a compiled script. Blocks and branches are resolved to
 * instruction indices: `{` jumps past its `}` when not selected, and a branch
 * to the end of the script targets the instruction count.
 */
export type SedCommand =
  | (SedSubstitute & Selected)
  | ({ readonly kind: SedSimpleVerb } & Selected)
  | ({ readonly kind: "a" | "i" | "c"; readonly text: string } & Selected)
  | ({ readonly kind: "y"; readonly map: ReadonlyMap<string, string> } & Selected)
  | ({ readonly kind: "b" | "t" | "T"; target: number } & Selected)
  | ({ readonly kind: "{"; end: number } & Selected);

const ADDRESS_START = /^(?:[0-9]+|\$|\/)/u;

function readDelimited(script: string, start: number, delimiter: string): [string, number] {
  let value = "";
  let index = start;
  while (index < script.length) {
    const character = script[index] ?? "";
    if (character === "\\" && script[index + 1] !== undefined) {
      const next = script[index + 1] ?? "";
      // Only the delimiter loses its slash. Other escapes must reach the regex
      // translator exactly as sed received them.
      value += next === delimiter ? next : `\\${next}`;
      index += 2;
      continue;
    }
    if (character === delimiter) return [value, index + 1];
    value += character;
    index += 1;
  }
  throw appletUsageError(SED, "unterminated expression");
}

/**
 * GNU sed reads `\n` and `\t` in a pattern as newline and tab, which a
 * multi-line pattern space needs; other escapes reach the regex translator.
 */
function sedPattern(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    const next = pattern[index + 1];
    if (character === "\\" && next !== undefined) {
      output += next === "n" ? "\n" : next === "t" ? "\t" : `\\${next}`;
      index += 1;
    } else output += character;
  }
  return output;
}

function parseAddress(
  script: string,
  start: number,
  dialect: PosixRegexDialect,
): [SedAddress, number] {
  const character = script[start] ?? "";
  if (character === "$") return [{ kind: "last" }, start + 1];
  if (character === "/") {
    const [pattern, next] = readDelimited(script, start + 1, "/");
    return [
      { kind: "regex", pattern: compilePosixRegex(sedPattern(pattern), dialect, SED.name) },
      next,
    ];
  }
  const digits = /^[0-9]+/u.exec(script.slice(start))?.[0] ?? "";
  const line = Number(digits);
  if (digits === "" || !Number.isSafeInteger(line) || line === 0) {
    throw appletUsageError(SED, "invalid address");
  }
  return [{ kind: "line", line }, start + digits.length];
}

interface SubstituteFlags {
  readonly global: boolean;
  readonly print: boolean;
  readonly ignoreCase: boolean;
  readonly occurrence: number;
}

/** Decodes `\\` and `\n` in a `y` operand; the delimiter's escape is already gone. */
function transliterationText(value: string): string[] {
  const characters: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      characters.push(character);
      continue;
    }
    index += 1;
    const next = value[index] ?? "\\";
    characters.push(next === "n" ? "\n" : next);
  }
  return characters;
}

/** Parser for the explicitly bounded sed language supported by this applet. */
class SedScriptParser {
  private index = 0;
  private readonly program: SedCommand[] = [];
  private readonly labels = new Map<string, number>();
  private readonly branches: Array<{ readonly at: number; readonly label: string }> = [];
  private readonly blocks: number[] = [];

  constructor(
    private readonly script: string,
    private readonly dialect: PosixRegexDialect,
  ) {}

  parse(): SedCommand[] {
    while (this.index < this.script.length) {
      if (this.skipTrivia()) continue;
      this.command();
    }
    if (this.blocks.length > 0) throw appletUsageError(SED, "unmatched {");
    if (this.program.length === 0 && this.labels.size === 0) {
      throw appletUsageError(SED, "empty script");
    }
    for (const branch of this.branches) {
      const target = branch.label === "" ? this.program.length : this.labels.get(branch.label);
      if (target === undefined) throw appletUsageError(SED, `can't find label ${branch.label}`);
      const command = this.program[branch.at];
      if (command?.kind === "b" || command?.kind === "t" || command?.kind === "T") {
        command.target = target;
      }
    }
    return this.program;
  }

  private skipTrivia(): boolean {
    const character = this.script[this.index] ?? "";
    if (";\n \t".includes(character)) {
      this.index += 1;
      return true;
    }
    if (character !== "#") return false;
    const newline = this.script.indexOf("\n", this.index);
    this.index = newline < 0 ? this.script.length : newline + 1;
    return true;
  }

  private selection(): Selected {
    const selector = this.selector();
    let negated = false;
    while (this.script[this.index] === "!" || (negated && this.script[this.index] === " ")) {
      if (this.script[this.index] === "!") negated = !negated;
      this.index += 1;
    }
    return { negated, ...(selector === undefined ? {} : { selector }) };
  }

  private selector(): SedSelector | undefined {
    if (!ADDRESS_START.test(this.script.slice(this.index))) return undefined;
    const [start, afterStart] = parseAddress(this.script, this.index, this.dialect);
    this.index = afterStart;
    if (this.script[this.index] !== ",") return { start };
    const [end, afterEnd] = parseAddress(this.script, this.index + 1, this.dialect);
    this.index = afterEnd;
    return { start, end };
  }

  private command(): void {
    const selected = this.selection();
    while (this.script[this.index] === " " || this.script[this.index] === "\t") this.index += 1;
    const verb = this.script[this.index] ?? "";
    if (verb === "s") {
      this.program.push(this.substitute(selected));
      return;
    }
    this.index += 1;
    if (SIMPLE_VERBS.has(verb)) {
      this.simple(verb as SedSimpleVerb, selected);
      return;
    }
    if (!this.structural(verb, selected)) this.operand(verb, selected);
  }

  /** Blocks and labels, which shape the program rather than act on a record. */
  private structural(verb: string, selected: Selected): boolean {
    if (verb === "{") {
      this.blocks.push(this.program.length);
      this.program.push({ kind: "{", end: -1, ...selected });
    } else if (verb === "}") {
      this.closeBlock(selected);
    } else if (verb === ":") {
      if (selected.selector !== undefined) {
        throw appletUsageError(SED, ": doesn't want any addresses");
      }
      const label = this.label();
      if (label === "") throw appletUsageError(SED, '":" lacks a label');
      this.labels.set(label, this.program.length);
    } else return false;
    return true;
  }

  /** Commands with an operand: a label, text, or a transliteration. */
  private operand(verb: string, selected: Selected): void {
    if (verb === "b" || verb === "t" || verb === "T") {
      this.branches.push({ at: this.program.length, label: this.label() });
      this.program.push({ kind: verb, target: -1, ...selected });
    } else if (verb === "a" || verb === "i" || verb === "c") {
      this.program.push({ kind: verb, text: this.text(), ...selected });
    } else if (verb === "y") {
      this.program.push(this.transliterate(selected));
    } else {
      throw appletUsageError(SED, `unsupported command ${verb === "" ? "at end of script" : verb}`);
    }
  }

  private simple(verb: SedSimpleVerb, selected: Selected): void {
    if ((verb === "q" || verb === "Q" || verb === "=") && selected.selector?.end !== undefined) {
      throw appletUsageError(SED, `${verb} accepts at most one address`);
    }
    this.program.push({ kind: verb, ...selected });
  }

  private closeBlock(selected: Selected): void {
    const open = this.blocks.pop();
    if (open === undefined) throw appletUsageError(SED, "unexpected }");
    if (selected.selector !== undefined || selected.negated) {
      throw appletUsageError(SED, "} doesn't want any addresses");
    }
    const command = this.program[open];
    if (command?.kind === "{") command.end = this.program.length;
    this.program.push({ kind: "}", negated: false });
  }

  /** A label runs to a newline or `;`, after leading blanks. */
  private label(): string {
    while (this.script[this.index] === " " || this.script[this.index] === "\t") this.index += 1;
    const start = this.index;
    while (this.index < this.script.length && !";\n".includes(this.script[this.index] ?? "")) {
      this.index += 1;
    }
    return this.script.slice(start, this.index).trimEnd();
  }

  /**
   * Text for `a`, `i` and `c`: GNU's one-line `a text` or POSIX `a\` with the
   * text on the following lines. A backslash-newline continues the text, and
   * a backslash before any other character keeps that character.
   */
  private text(): string {
    while (this.script[this.index] === " " || this.script[this.index] === "\t") this.index += 1;
    if (this.script[this.index] === "\\") {
      this.index += 1;
      if (this.script[this.index] === "\n") this.index += 1;
    }
    let text = "";
    while (this.index < this.script.length && this.script[this.index] !== "\n") {
      const character = this.script[this.index] ?? "";
      if (character === "\\" && this.index + 1 < this.script.length) {
        text += this.script[this.index + 1];
        this.index += 2;
        continue;
      }
      text += character;
      this.index += 1;
    }
    return text;
  }

  private transliterate(selected: Selected): SedCommand {
    const delimiter = this.script[this.index];
    if (delimiter === undefined || /[\\\n]/u.test(delimiter)) {
      throw appletUsageError(SED, "invalid y delimiter");
    }
    const [source, afterSource] = readDelimited(this.script, this.index + 1, delimiter);
    const [target, afterTarget] = readDelimited(this.script, afterSource, delimiter);
    this.index = afterTarget;
    const from = transliterationText(source);
    const to = transliterationText(target);
    if (from.length !== to.length) {
      throw appletUsageError(SED, "strings for y command are different lengths");
    }
    const map = new Map<string, string>();
    from.forEach((character, position) => {
      map.set(character, to[position] ?? character);
    });
    return { kind: "y", map, ...selected };
  }

  private substitute(selected: Selected): SedCommand {
    const delimiter = this.script[this.index + 1];
    if (delimiter === undefined || /[\\\n]/u.test(delimiter)) {
      throw appletUsageError(SED, "invalid s delimiter");
    }
    const [pattern, afterPattern] = readDelimited(this.script, this.index + 2, delimiter);
    const [replacement, afterReplacement] = readDelimited(this.script, afterPattern, delimiter);
    this.index = afterReplacement;
    const flags = this.substituteFlags();
    return {
      kind: "s",
      pattern: compilePosixRegex(sedPattern(pattern), this.dialect, SED.name, {
        ...(flags.ignoreCase ? { ignoreCase: true } : {}),
      }),
      replacement,
      global: flags.global,
      print: flags.print,
      occurrence: flags.occurrence,
      ...selected,
    };
  }

  private substituteFlags(): SubstituteFlags {
    let global = false;
    let print = false;
    let ignoreCase = false;
    let occurrence = 0;
    for (; this.index < this.script.length; this.index += 1) {
      const flag = this.script[this.index] ?? "";
      if (flag === "g") global = true;
      else if (flag === "p") print = true;
      else if (flag === "I" || flag === "i") ignoreCase = true;
      else if (/[0-9]/u.test(flag)) occurrence = this.occurrence();
      else break;
    }
    return { global, print, ignoreCase, occurrence };
  }

  private occurrence(): number {
    const digits = /^[0-9]+/u.exec(this.script.slice(this.index))?.[0] ?? "";
    const occurrence = Number(digits);
    if (occurrence === 0) throw appletUsageError(SED, "s occurrence must be positive");
    this.index += digits.length - 1;
    return occurrence;
  }
}

export function parseSedScript(script: string, dialect: PosixRegexDialect): SedCommand[] {
  return new SedScriptParser(script, dialect).parse();
}
