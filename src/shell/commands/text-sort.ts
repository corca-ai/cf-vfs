import { compareUtf8 } from "../../core/path.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { inputTexts, writeText } from "./helpers.js";
import { checkedTextLines } from "./text-lines.js";

const SORT = {
  name: "sort",
  usage: "[-bcCfnrsu] [-t SEP] [-k POS1[,POS2]]... [FILE...]",
  summary: "sorts records by UTF-8 byte order, by keys, or numerically",
  options: {
    short: {
      b: { name: "ignore-blanks" },
      c: { name: "check" },
      C: { name: "check-quiet" },
      f: { name: "fold" },
      r: { name: "reverse" },
      s: { name: "stable" },
      u: { name: "unique" },
      n: { name: "numeric" },
      t: { name: "separator", argument: true },
      k: { name: "key", argument: true },
    },
    long: {
      "ignore-leading-blanks": { name: "ignore-blanks" },
      check: { name: "check" },
      "ignore-case": { name: "fold" },
      reverse: { name: "reverse" },
      stable: { name: "stable" },
      unique: { name: "unique" },
      "numeric-sort": { name: "numeric" },
      "field-separator": { name: "separator", argument: true },
      key: { name: "key", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<
  | "ignore-blanks"
  | "check"
  | "check-quiet"
  | "fold"
  | "reverse"
  | "stable"
  | "unique"
  | "numeric"
  | "separator"
  | "key"
>;

interface NumericSortKey {
  negative: boolean;
  integer: string;
  fraction: string;
}

const ZERO_NUMERIC_SORT_KEY: NumericSortKey = {
  negative: false,
  integer: "0",
  fraction: "",
};

function numericSortKey(value: string): NumericSortKey {
  const match = /^[ \t]*(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))/u.exec(value);
  if (match === null) return ZERO_NUMERIC_SORT_KEY;
  const integer = (match[2] ?? "").replace(/^0+/u, "") || "0";
  const fraction = (match[3] ?? match[4] ?? "").replace(/0+$/u, "");
  const zero = integer === "0" && fraction.length === 0;
  return { negative: match[1] === "-" && !zero, integer, fraction };
}

function compareNumericSortKeys(left: NumericSortKey, right: NumericSortKey): number {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const order = compareNumericMagnitude(left, right);
  return left.negative ? -order : order;
}

function compareNumericMagnitude(left: NumericSortKey, right: NumericSortKey): number {
  const lengthOrder = left.integer.length - right.integer.length;
  if (lengthOrder !== 0) return lengthOrder;
  if (left.integer !== right.integer) return left.integer < right.integer ? -1 : 1;
  const length = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < length; index += 1) {
    const order =
      (left.fraction.charCodeAt(index) || 48) - (right.fraction.charCodeAt(index) || 48);
    if (order !== 0) return order;
  }
  return 0;
}

/** Ordering options, either global or for one key. */
interface SortOrdering {
  readonly numeric: boolean;
  readonly reverse: boolean;
  readonly fold: boolean;
  readonly blanks: boolean;
}

/** One `-k` key: 1-based field and character positions, `endChar` 0 meaning the field's end. */
interface SortKey extends SortOrdering {
  readonly startField: number;
  readonly startChar: number;
  readonly endField: number | undefined;
  readonly endChar: number;
  /** `b` on the end position, which counts its characters after leading blanks. */
  readonly endBlanks: boolean;
}

interface SortInvocation {
  readonly operands: readonly string[];
  /** `-c` reports the first disorder; `-C` only sets the status. */
  readonly check: "report" | "quiet" | undefined;
  readonly keys: readonly SortKey[];
  readonly separator: string | undefined;
  readonly unique: boolean;
  readonly stable: boolean;
  readonly reverse: boolean;
}

const KEY_POSITION = /^(\d+)(?:\.(\d+))?([bfnr]*)$/u;

function keyPosition(value: string, start: boolean): { field: number; char: number; opts: string } {
  const match = KEY_POSITION.exec(value);
  const field = Number(match?.[1] ?? "0");
  const char = Number(match?.[2] ?? (start ? "1" : "0"));
  if (match === null || field < 1 || (start && char < 1)) {
    throw appletUsageError(SORT, `invalid key position ${value}`);
  }
  return { field, char, opts: match[3] ?? "" };
}

/** GNU: a key with no ordering options of its own inherits every global one. */
function parseKey(value: string, global: SortOrdering): SortKey {
  const [startText = "", endText, extra] = value.split(",");
  if (extra !== undefined) throw appletUsageError(SORT, `invalid key ${value}`);
  const start = keyPosition(startText, true);
  const end = endText === undefined ? undefined : keyPosition(endText, false);
  const opts = start.opts + (end?.opts ?? "");
  const own = (letter: string): boolean => opts.includes(letter);
  const ordering: SortOrdering =
    opts === ""
      ? global
      : { numeric: own("n"), reverse: own("r"), fold: own("f"), blanks: start.opts.includes("b") };
  return {
    ...ordering,
    startField: start.field,
    startChar: start.char,
    endField: end?.field,
    endChar: end?.char ?? 0,
    endBlanks: opts === "" ? global.blanks : (end?.opts.includes("b") ?? false),
  };
}

function parseSortInvocation(argv: readonly string[]): SortInvocation {
  const parsed = parseAppletOptions(SORT, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const values = (name: string): string[] =>
    parsed.options.flatMap((option) =>
      option.name === name && "argument" in option ? [option.argument] : [],
    );
  const global: SortOrdering = {
    numeric: has("numeric"),
    reverse: has("reverse"),
    fold: has("fold"),
    blanks: has("ignore-blanks"),
  };
  const separators = values("separator");
  const separator = separators.at(-1);
  if (separator !== undefined && [...separator].length !== 1) {
    throw appletUsageError(SORT, "the separator must be one character");
  }
  const keys = values("key").map((value) => parseKey(value, global));
  return {
    operands: parsed.operands,
    check: has("check") ? "report" : has("check-quiet") ? "quiet" : undefined,
    // Without -k the whole line is the one key.
    keys:
      keys.length > 0
        ? keys
        : [
            {
              ...global,
              startField: 1,
              startChar: 1,
              endField: undefined,
              endChar: 0,
              endBlanks: global.blanks,
            },
          ],
    separator,
    unique: has("unique"),
    stable: has("stable"),
    reverse: global.reverse,
  };
}

const isBlank = (character: string | undefined): boolean => character === " " || character === "\t";

/** Field `[start, end)` offsets: split on the separator, or each run of blanks opens a field. */
function fieldBounds(line: string, separator: string | undefined): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  if (separator !== undefined) {
    let start = 0;
    for (let at = line.indexOf(separator); at !== -1; at = line.indexOf(separator, start)) {
      bounds.push([start, at]);
      start = at + separator.length;
    }
    bounds.push([start, line.length]);
    return bounds;
  }
  let index = 0;
  while (index < line.length) {
    const start = index;
    while (isBlank(line[index])) index += 1;
    while (index < line.length && !isBlank(line[index])) index += 1;
    bounds.push([start, index]);
  }
  return bounds;
}

function skipBlanks(line: string, from: number, limit: number): number {
  let index = from;
  while (index < limit && isBlank(line[index])) index += 1;
  return index;
}

function keyText(line: string, bounds: readonly [number, number][], key: SortKey): string {
  const first = bounds[key.startField - 1];
  if (first === undefined) return "";
  const startBase = key.blanks ? skipBlanks(line, first[0], first[1]) : first[0];
  const start = Math.min(startBase + key.startChar - 1, first[1]);
  let end = line.length;
  const last = key.endField === undefined ? undefined : bounds[key.endField - 1];
  if (last !== undefined) {
    const endBase = key.endBlanks ? skipBlanks(line, last[0], last[1]) : last[0];
    end = key.endChar === 0 ? last[1] : Math.min(endBase + key.endChar, last[1]);
  }
  const text = end > start ? line.slice(start, end) : "";
  return key.fold ? text.replace(/[a-z]/gu, (character) => character.toUpperCase()) : text;
}

interface SortRecord {
  readonly value: string;
  readonly keys: readonly (string | NumericSortKey)[];
}

function compareKeys(left: SortRecord, right: SortRecord, keys: readonly SortKey[]): number {
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const a = left.keys[index] ?? "";
    const b = right.keys[index] ?? "";
    const order =
      typeof a === "string" || typeof b === "string"
        ? compareUtf8(String(a), String(b))
        : compareNumericSortKeys(a, b);
    if (order !== 0) return key?.reverse === true ? -order : order;
  }
  return 0;
}

function sortRecords(lines: readonly string[], invocation: SortInvocation): SortRecord[] {
  return lines.map((line): SortRecord => {
    const value = line.endsWith("\n") ? line.slice(0, -1) : line;
    const bounds = fieldBounds(value, invocation.separator);
    const keys = invocation.keys.map((key) => {
      const text = keyText(value, bounds, key);
      return key.numeric ? numericSortKey(text) : text;
    });
    return { value, keys };
  });
}

function compareRecords(left: SortRecord, right: SortRecord, invocation: SortInvocation): number {
  const order = compareKeys(left, right, invocation.keys);
  // The last-resort comparison of whole lines, which -s and -u turn off.
  if (order !== 0 || invocation.stable || invocation.unique) return order;
  const whole = compareUtf8(left.value, right.value);
  return invocation.reverse ? -whole : whole;
}

/** The 1-based line of the first record out of order, `-u` also refusing equal neighbours. */
function firstDisorder(
  records: readonly SortRecord[],
  invocation: SortInvocation,
): number | undefined {
  for (let index = 1; index < records.length; index += 1) {
    const order = compareRecords(
      records[index - 1] as SortRecord,
      records[index] as SortRecord,
      invocation,
    );
    if (order > 0 || (invocation.unique && order === 0)) return index + 1;
  }
  return undefined;
}

function sortedRecords(lines: readonly string[], invocation: SortInvocation): SortRecord[] {
  let records = sortRecords(lines, invocation);
  records.sort((left, right) => compareRecords(left, right, invocation));
  if (invocation.unique) {
    records = records.filter(
      (record, index) =>
        index === 0 || compareKeys(record, records[index - 1] ?? record, invocation.keys) !== 0,
    );
  }
  return records;
}

export const sortCommand = /* @__PURE__ */ defineApplet(SORT, async (context, argv, fds) => {
  const invocation = parseSortInvocation(argv);
  const collected = await inputTexts(context, invocation.operands, fds[0]);
  try {
    const lines = checkedTextLines(
      collected.value
        .map(({ text }) => (text === "" || text.endsWith("\n") ? text : `${text}\n`))
        .join(""),
      context.budget.limits.maxBufferedRecords,
      context.budget.limits.maxLineBytes,
    );
    if (invocation.check !== undefined) {
      const records = sortRecords(lines, invocation);
      const disorder = firstDisorder(records, invocation);
      if (disorder === undefined) return 0;
      if (invocation.check === "report") {
        const name = invocation.operands[0] ?? "-";
        const line = records[disorder - 1]?.value ?? "";
        await writeText(fds[2], `sort: ${name}:${disorder}: disorder: ${line}\n`);
      }
      return 1;
    }
    const records = sortedRecords(lines, invocation);
    await writeText(fds[1], records.map((record) => `${record.value}\n`).join(""));
    return 0;
  } finally {
    collected.release();
  }
});

/**
 * Every matched part of `line`, left to right.
 *
 * An empty match cannot be printed and cannot advance the scan, so it is
 * stepped over — `grep -oE "X*"` reports the `X` runs and not the nothing
 * between them, which is what GNU grep does.
 */
