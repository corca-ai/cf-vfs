import {
  compilePosixRegex,
  type PosixRegex,
  type PosixRegexDialect,
} from "../../core/posix-regex.js";
import { type AppletSpecWithOptions, appletUsageError } from "./applet.js";

export const SED = {
  name: "sed",
  usage: "[-En] [-i] [-e SCRIPT] [SCRIPT] [FILE...]",
  summary: "edits records with a bounded subset of the sed language",
  options: {
    short: {
      n: { name: "quiet" },
      E: { name: "extended" },
      i: { name: "in-place" },
      e: { name: "expression", argument: true },
    },
    long: {
      quiet: { name: "quiet" },
      "in-place": { name: "in-place" },
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

export type SedCommand =
  | (SedSubstitute & Selected)
  | ({ readonly kind: "p" } & Selected)
  | ({ readonly kind: "d" } & Selected)
  | ({ readonly kind: "q" } & Selected);

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

function parseAddress(
  script: string,
  start: number,
  dialect: PosixRegexDialect,
): [SedAddress, number] {
  const character = script[start] ?? "";
  if (character === "$") return [{ kind: "last" }, start + 1];
  if (character === "/") {
    const [pattern, next] = readDelimited(script, start + 1, "/");
    return [{ kind: "regex", pattern: compilePosixRegex(pattern, dialect, SED.name) }, next];
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

/** Parser for the explicitly bounded sed language supported by this applet. */
class SedScriptParser {
  private index = 0;

  constructor(
    private readonly script: string,
    private readonly dialect: PosixRegexDialect,
  ) {}

  parse(): SedCommand[] {
    const commands: SedCommand[] = [];
    while (this.index < this.script.length) {
      if (this.skipTrivia()) continue;
      commands.push(this.command());
    }
    if (commands.length === 0) throw appletUsageError(SED, "empty script");
    return commands;
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
    while (this.script[this.index] === "!") {
      negated = !negated;
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

  private command(): SedCommand {
    const selected = this.selection();
    const verb = this.script[this.index];
    if (verb === "s") return this.substitute(selected);
    if (verb === "p" || verb === "d") {
      this.index += 1;
      return verb === "p" ? { kind: "p", ...selected } : { kind: "d", ...selected };
    }
    if (verb === "q") return this.quit(selected);
    throw appletUsageError(SED, `unsupported command ${verb ?? "at end of script"}`);
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
      pattern: compilePosixRegex(pattern, this.dialect, SED.name, {
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

  private quit(selected: Selected): SedCommand {
    if (selected.selector?.end !== undefined) {
      throw appletUsageError(SED, "q accepts at most one address");
    }
    this.index += 1;
    return { kind: "q", ...selected };
  }
}

export function parseSedScript(script: string, dialect: PosixRegexDialect): SedCommand[] {
  return new SedScriptParser(script, dialect).parse();
}
