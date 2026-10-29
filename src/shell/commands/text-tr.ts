import { VfsError } from "../../core/errors.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { BufferedTextWriter, readWithAbort } from "./helpers.js";

const TR = {
  name: "tr",
  usage: "[-cdsC] SET1 [SET2]",
  summary: "translates, deletes, or squeezes characters",
  options: {
    short: {
      c: { name: "complement" },
      C: { name: "complement" },
      d: { name: "delete" },
      s: { name: "squeeze" },
    },
    long: {
      complement: { name: "complement" },
      delete: { name: "delete" },
      "squeeze-repeats": { name: "squeeze" },
    },
    // GNU `tr` stops at its first set, so `tr a -x` names a set, not an option.
    stopAtFirstOperand: true,
  },
} as const satisfies AppletSpecWithOptions<"complement" | "delete" | "squeeze">;

const ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function asciiWhere(predicate: (code: number) => boolean): string[] {
  const characters: string[] = [];
  for (let code = 0; code < 128; code += 1) {
    if (predicate(code)) characters.push(String.fromCharCode(code));
  }
  return characters;
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isUpper = (code: number): boolean => code >= 0x41 && code <= 0x5a;
const isLower = (code: number): boolean => code >= 0x61 && code <= 0x7a;
const isGraph = (code: number): boolean => code > 0x20 && code < 0x7f;

/** POSIX-locale classes, in ascending order so `[:upper:]` and `[:lower:]` pair up. */
const CLASSES: Readonly<Record<string, () => string[]>> = {
  alnum: () => asciiWhere((code) => isDigit(code) || isUpper(code) || isLower(code)),
  alpha: () => asciiWhere((code) => isUpper(code) || isLower(code)),
  blank: () => [" ", "\t"].sort(),
  cntrl: () => asciiWhere((code) => code < 0x20 || code === 0x7f),
  digit: () => asciiWhere(isDigit),
  graph: () => asciiWhere(isGraph),
  lower: () => asciiWhere(isLower),
  print: () => asciiWhere((code) => code === 0x20 || isGraph(code)),
  punct: () =>
    asciiWhere((code) => isGraph(code) && !isDigit(code) && !isUpper(code) && !isLower(code)),
  space: () => asciiWhere((code) => code === 0x20 || (code >= 0x09 && code <= 0x0d)),
  upper: () => asciiWhere(isUpper),
  xdigit: () =>
    asciiWhere(
      (code) => isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66),
    ),
};

const CLASS_SYNTAX = /^\[:([a-z]*):\]/u;

/** Reads one set operand left to right, charging every character it adds. */
class SetScanner {
  private readonly characters: string[];
  private index = 0;
  readonly set: string[] = [];

  constructor(
    value: string,
    private readonly context: ShellCommandContext,
  ) {
    this.characters = [...value];
  }

  get done(): boolean {
    return this.index >= this.characters.length;
  }

  /** Charges characters before they are built, so no set outgrows the limit first. */
  reserve(count: number): void {
    if (this.set.length + count > this.context.budget.limits.maxExpansionChars) {
      throw new VfsError("E2BIG", "tr: character set exceeds the expansion limit");
    }
    this.context.budget.expansionWork(count);
  }

  /** Consumes a `[:name:]` class, or nothing. */
  characterClass(): readonly string[] | undefined {
    const named = CLASS_SYNTAX.exec(this.characters.slice(this.index, this.index + 10).join(""));
    if (named === null) return undefined;
    const name = named[1] ?? "";
    const expand = Object.hasOwn(CLASSES, name) ? CLASSES[name] : undefined;
    if (expand === undefined) throw appletUsageError(TR, `invalid character class ${named[0]}`);
    this.index += named[0].length;
    return expand();
  }

  /** Consumes one character, decoding a backslash escape. */
  character(): string {
    const character = this.characters[this.index] ?? "";
    this.index += 1;
    if (character !== "\\" || this.done) return character;
    const escaped = this.characters[this.index] ?? "";
    this.index += 1;
    return /^[0-7]$/u.test(escaped) ? this.octal(escaped) : (ESCAPES[escaped] ?? escaped);
  }

  /** Consumes `-END` after a range start, or nothing. */
  rangeEnd(): string | undefined {
    if (this.characters[this.index] !== "-" || this.index + 1 >= this.characters.length) {
      return undefined;
    }
    this.index += 1;
    return this.character();
  }

  private octal(first: string): string {
    let digits = first;
    while (digits.length < 3 && /^[0-7]$/u.test(this.characters[this.index] ?? "")) {
      digits += this.characters[this.index];
      this.index += 1;
    }
    return String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
  }
}

function rangeBounds(start: string, end: string): { from: number; count: number } {
  const from = start.codePointAt(0) ?? 0;
  const to = end.codePointAt(0) ?? 0;
  if (to < from) {
    throw appletUsageError(TR, `range-endpoints of '${start}-${end}' are in reverse order`);
  }
  return { from, count: to - from + 1 };
}

/**
 * Expands one set operand: backslash escapes (`\n`, `\t`, `\\`, octal `\NNN`),
 * ranges anywhere in the set, and `[:class:]` names. `[=c=]` and `[c*n]` are
 * not part of the profile; their brackets read as literal characters.
 */
function characterSet(value: string, context: ShellCommandContext): string[] {
  const scanner = new SetScanner(value, context);
  while (!scanner.done) {
    const members = scanner.characterClass();
    if (members !== undefined) {
      scanner.reserve(members.length);
      for (const member of members) scanner.set.push(member);
      continue;
    }
    const start = scanner.character();
    const end = scanner.rangeEnd();
    const { from, count } = end === undefined ? { from: -1, count: 1 } : rangeBounds(start, end);
    scanner.reserve(count);
    if (end === undefined) scanner.set.push(start);
    else
      for (let offset = 0; offset < count; offset += 1)
        scanner.set.push(String.fromCodePoint(from + offset));
  }
  return scanner.set;
}

/** GNU orders a complement by byte value; characters above that all take SET2's last. */
function complementOf(set: readonly string[]): string[] {
  const members = new Set(set);
  const complement: string[] = [];
  for (let code = 0; code < 256; code += 1) {
    const character = String.fromCharCode(code);
    if (!members.has(character)) complement.push(character);
  }
  return complement;
}

type CharacterMap = (character: string) => string;

function translation(
  from: readonly string[],
  to: readonly string[],
  complement: boolean,
): CharacterMap {
  if (to.length === 0) throw appletUsageError(TR, "SET2 must be non-empty when translating");
  const source = complement ? complementOf(from) : from;
  const last = to[to.length - 1] ?? "";
  const map = new Map<string, string>();
  // A character listed twice in SET1 takes its last mapping, as GNU does.
  source.forEach((character, position) => {
    map.set(character, to[Math.min(position, to.length - 1)] ?? last);
  });
  if (!complement) return (character) => map.get(character) ?? character;
  const members = new Set(from);
  return (character) => map.get(character) ?? (members.has(character) ? character : last);
}

function membership(set: readonly string[], complement: boolean): (character: string) => boolean {
  const members = new Set(set);
  return complement
    ? (character) => !members.has(character)
    : (character) => members.has(character);
}

interface TrPlan {
  readonly translate: CharacterMap | undefined;
  readonly remove: ((character: string) => boolean) | undefined;
  readonly squeeze: ((character: string) => boolean) | undefined;
}

/** `-d` takes one set, `-ds` two, `-s` one or two, and translation two. */
function setsAccepted(remove: boolean, squeeze: boolean, count: number): boolean {
  if (remove) return count === (squeeze ? 2 : 1);
  return squeeze ? count === 1 || count === 2 : count === 2;
}

function plan(argv: readonly string[], context: ShellCommandContext): TrPlan {
  const parsed = parseAppletOptions(TR, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const complement = has("complement");
  const remove = has("delete");
  const squeeze = has("squeeze");
  const sets = parsed.operands;
  if (!setsAccepted(remove, squeeze, sets.length)) {
    throw appletUsageError(TR, remove && !squeeze ? "-d takes one set" : "requires SET1 and SET2");
  }
  const first = characterSet(sets[0] ?? "", context);
  const second = sets.length === 2 ? characterSet(sets[1] ?? "", context) : undefined;
  if (remove) {
    return {
      translate: undefined,
      remove: membership(first, complement),
      squeeze: second === undefined ? undefined : membership(second, false),
    };
  }
  if (second === undefined) {
    return { translate: undefined, remove: undefined, squeeze: membership(first, complement) };
  }
  return {
    translate: translation(first, second, complement),
    remove: undefined,
    squeeze: squeeze ? membership(second, false) : undefined,
  };
}

/** Applies a plan to decoded text, carrying the last written character across chunks. */
function transformer(trPlan: TrPlan): (text: string) => string {
  let previous: string | undefined;
  return (text) => {
    let result = "";
    for (const input of text) {
      if (trPlan.remove?.(input) === true) continue;
      const character = trPlan.translate?.(input) ?? input;
      if (character === previous && trPlan.squeeze?.(character) === true) continue;
      previous = character;
      result += character;
    }
    return result;
  };
}

function decodeChunk(decoder: TextDecoder, chunk?: Uint8Array): string {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
  } catch (error) {
    if (error instanceof TypeError) throw new VfsError("EIO", "input is not valid UTF-8");
    throw error;
  }
}

export const trCommand = /* @__PURE__ */ defineApplet(TR, async (context, argv, fds) => {
  const transform = transformer(plan(argv, context));
  const reader = fds[0].getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    while (true) {
      const read = await readWithAbort(reader, context.signal);
      if (read.done) break;
      context.budget.io(read.value.byteLength);
      await output.write(transform(decodeChunk(decoder, read.value)));
    }
    await output.write(transform(decodeChunk(decoder)));
    await output.flush();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    output.abort();
  }
  return 0;
});
