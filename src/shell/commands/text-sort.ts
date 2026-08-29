import { compareUtf8 } from "../../core/path.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { inputTexts, writeText } from "./helpers.js";
import { checkedTextLines } from "./text-lines.js";

const SORT = {
  name: "sort",
  usage: "[-nru] [FILE...]",
  summary: "sorts records by UTF-8 byte order, or numerically with -n",
  options: {
    short: {
      r: { name: "reverse" },
      u: { name: "unique" },
      n: { name: "numeric" },
    },
  },
} as const satisfies AppletSpecWithOptions<"reverse" | "unique" | "numeric">;

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

interface SortRecord {
  readonly value: string;
  readonly numericKey?: NumericSortKey;
}

interface SortInvocation {
  readonly operands: readonly string[];
  readonly reverse: boolean;
  readonly unique: boolean;
  readonly numeric: boolean;
}

function parseSortInvocation(argv: readonly string[]): SortInvocation {
  const parsed = parseAppletOptions(SORT, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  return {
    operands: parsed.operands,
    reverse: has("reverse"),
    unique: has("unique"),
    numeric: has("numeric"),
  };
}

function sortKeyOrder(left: SortRecord, right: SortRecord, numeric: boolean): number {
  return numeric
    ? compareNumericSortKeys(
        left.numericKey ?? ZERO_NUMERIC_SORT_KEY,
        right.numericKey ?? ZERO_NUMERIC_SORT_KEY,
      )
    : compareUtf8(left.value, right.value);
}

function compareSortRecords(
  left: SortRecord,
  right: SortRecord,
  invocation: SortInvocation,
): number {
  let order = sortKeyOrder(left, right, invocation.numeric);
  // `-u` preserves the first spelling of equal numeric keys.
  if (order === 0 && !invocation.unique) order = compareUtf8(left.value, right.value);
  return invocation.reverse ? -order : order;
}

function sortedRecords(lines: readonly string[], invocation: SortInvocation): SortRecord[] {
  let records = lines.map((line): SortRecord => {
    const value = line.endsWith("\n") ? line.slice(0, -1) : line;
    return { value, ...(invocation.numeric ? { numericKey: numericSortKey(value) } : {}) };
  });
  records.sort((left, right) => compareSortRecords(left, right, invocation));
  if (invocation.unique) {
    records = records.filter(
      (record, index) =>
        index === 0 || sortKeyOrder(record, records[index - 1] ?? record, invocation.numeric) !== 0,
    );
  }
  return records;
}

export const sortCommand = /* @__PURE__ */ defineApplet(SORT, async (context, argv, fds) => {
  const invocation = parseSortInvocation(argv);
  const collected = await inputTexts(context, invocation.operands, fds[0]);
  try {
    const lines = checkedTextLines(
      collected.value.map((input) => input.text).join(""),
      context.budget.limits.maxBufferedRecords,
      context.budget.limits.maxLineBytes,
    );
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
