import { VfsError } from "../../core/errors.js";
import { compareUtf8 } from "../../core/path.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { BufferedTextWriter, inputTexts, parseInteger } from "./helpers.js";
import type { ParsedUtilityOption } from "./options.js";
import { checkedTextLines } from "./text-lines.js";

const COMM = {
  name: "comm",
  usage: "[-123] [--nocheck-order] FILE1 FILE2",
  summary: "compares two sorted files record by record",
  options: {
    short: {
      1: { name: "suppress-left" },
      2: { name: "suppress-right" },
      3: { name: "suppress-common" },
    },
    long: {
      "nocheck-order": { name: "no-check-order" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "suppress-left" | "suppress-right" | "suppress-common" | "no-check-order"
>;

const JOIN = {
  name: "join",
  usage: "[-t DELIM] [-1 FIELD] [-2 FIELD] [-a 1|2] FILE1 FILE2",
  summary: "joins two sorted files on a common field",
  options: {
    short: {
      t: { name: "delimiter", argument: true },
      1: { name: "left-field", argument: true },
      2: { name: "right-field", argument: true },
      a: { name: "include-unpaired", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "delimiter" | "left-field" | "right-field" | "include-unpaired"
>;

function requireSorted(lines: readonly string[], name: string): void {
  for (let index = 1; index < lines.length; index += 1) {
    if (compareUtf8(lines[index - 1] ?? "", lines[index] ?? "") > 0) {
      throw appletUsageError(COMM, `${name} is not sorted`);
    }
  }
}

interface CommRow {
  readonly column: 0 | 1 | 2;
  readonly line: string;
  readonly takeLeft: boolean;
  readonly takeRight: boolean;
}

function nextCommRow(left: string | undefined, right: string | undefined): CommRow {
  if (left !== undefined && left === right) {
    return { column: 2, line: left, takeLeft: true, takeRight: true };
  }
  if (right === undefined || (left !== undefined && compareUtf8(left, right) < 0)) {
    return { column: 0, line: left ?? "", takeLeft: true, takeRight: false };
  }
  return { column: 1, line: right, takeLeft: false, takeRight: true };
}

function checkCommOrder(
  enabled: boolean,
  left: readonly string[],
  right: readonly string[],
  paths: readonly string[],
): void {
  if (!enabled) return;
  requireSorted(left, paths[0] ?? "left input");
  requireSorted(right, paths[1] ?? "right input");
}

export const commCommand = /* @__PURE__ */ defineApplet(COMM, async (context, argv, fds) => {
  const parsed = parseAppletOptions(COMM, argv);
  const suppressLeft = parsed.options.some((option) => option.name === "suppress-left");
  const suppressRight = parsed.options.some((option) => option.name === "suppress-right");
  const suppressCommon = parsed.options.some((option) => option.name === "suppress-common");
  const checkOrder = !parsed.options.some((option) => option.name === "no-check-order");
  const paths = parsed.operands;
  if (paths.length !== 2) throw appletUsageError(COMM, "requires two files");
  const collected = await inputTexts(context, paths, fds[0]);
  try {
    const inputs = collected.value;
    const left = checkedTextLines(
      inputs[0]?.text ?? "",
      context.budget.limits.maxBufferedRecords,
      context.budget.limits.maxLineBytes,
    ).map((line) => line.replace(/\n$/u, ""));
    const right = checkedTextLines(
      inputs[1]?.text ?? "",
      context.budget.limits.maxBufferedRecords,
      context.budget.limits.maxLineBytes,
    ).map((line) => line.replace(/\n$/u, ""));
    checkCommOrder(checkOrder, left, right, paths);
    const visible = [!suppressLeft, !suppressRight, !suppressCommon];
    let leftIndex = 0;
    let rightIndex = 0;
    const output = new BufferedTextWriter(context, fds[1]);
    try {
      while (leftIndex < left.length || rightIndex < right.length) {
        const row = nextCommRow(left[leftIndex], right[rightIndex]);
        if (row.takeLeft) leftIndex += 1;
        if (row.takeRight) rightIndex += 1;
        if (visible[row.column]) {
          const prefix = visible.slice(0, row.column).filter(Boolean).length;
          await output.write(`${"\t".repeat(prefix)}${row.line}\n`);
        }
      }
      await output.flush();
    } finally {
      output.abort();
    }
    return 0;
  } finally {
    collected.release();
  }
});

interface JoinLine {
  readonly fields: readonly string[];
  readonly key: string;
  readonly text: string;
}

interface JoinInvocation {
  readonly paths: readonly string[];
  readonly delimiter: string;
  readonly leftField: number;
  readonly rightField: number;
  readonly includeUnpaired: ReadonlySet<1 | 2>;
}

interface MutableJoinOptions {
  delimiter: string;
  leftField: number;
  rightField: number;
  readonly includeUnpaired: Set<1 | 2>;
}

function applyJoinOption(
  values: MutableJoinOptions,
  option: ParsedUtilityOption<"delimiter" | "left-field" | "right-field" | "include-unpaired">,
): void {
  if (!("argument" in option)) return;
  if (option.name === "delimiter") values.delimiter = option.argument;
  else if (option.name === "left-field") {
    values.leftField = parseInteger(option.argument, `${JOIN.name}: -1 field`, 1);
  } else if (option.name === "right-field") {
    values.rightField = parseInteger(option.argument, `${JOIN.name}: -2 field`, 1);
  } else if (option.name === "include-unpaired") {
    const side = parseInteger(option.argument, `${JOIN.name}: -a file`, 1);
    if (side !== 1 && side !== 2) throw appletUsageError(JOIN, "-a must be 1 or 2");
    values.includeUnpaired.add(side);
  }
}

function parseJoinInvocation(argv: readonly string[]): JoinInvocation {
  const parsed = parseAppletOptions(JOIN, argv);
  const values: MutableJoinOptions = {
    delimiter: " ",
    leftField: 1,
    rightField: 1,
    includeUnpaired: new Set(),
  };
  for (const option of parsed.options) applyJoinOption(values, option);
  if (values.delimiter.length !== 1) {
    throw appletUsageError(JOIN, "delimiter must be one character");
  }
  if (parsed.operands.length !== 2) throw appletUsageError(JOIN, "requires two files");
  return { paths: parsed.operands, ...values };
}

function parseJoinLine(
  line: string,
  index: number,
  field: number,
  file: 1 | 2,
  delimiter: string,
): JoinLine {
  const value = line.replace(/\n$/u, "");
  const fields = delimiter === " " ? value.trim().split(/[ \t]+/u) : value.split(delimiter);
  const key = fields[field - 1];
  if (key === undefined) {
    throw appletUsageError(JOIN, `file ${file} line ${index + 1} lacks field ${field}`);
  }
  return { fields, key, text: value };
}

function parseJoinLines(
  text: string,
  field: number,
  file: 1 | 2,
  invocation: JoinInvocation,
  context: ShellCommandContext,
): JoinLine[] {
  const lines = checkedTextLines(
    text,
    context.budget.limits.maxBufferedRecords,
    context.budget.limits.maxLineBytes,
  ).map((line, index) => parseJoinLine(line, index, field, file, invocation.delimiter));
  for (let index = 1; index < lines.length; index += 1) {
    if (compareUtf8(lines[index - 1]?.key ?? "", lines[index]?.key ?? "") > 0) {
      throw appletUsageError(JOIN, `${invocation.paths[file - 1] ?? `file ${file}`} is not sorted`);
    }
  }
  return lines;
}

class JoinOutput {
  private rows = 0;

  constructor(
    private readonly output: BufferedTextWriter,
    private readonly maximumRows: number,
  ) {}

  async emit(line: string): Promise<void> {
    this.rows += 1;
    if (this.rows > this.maximumRows) {
      throw new VfsError("E2BIG", "join output record limit exceeded");
    }
    await this.output.write(`${line}\n`);
  }
}

function joinOrder(left: JoinLine | undefined, right: JoinLine | undefined): number {
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return compareUtf8(left.key, right.key);
}

function matchingEnd(lines: readonly JoinLine[], start: number, key: string): number {
  let end = start;
  while (lines[end]?.key === key) end += 1;
  return end;
}

async function emitJoinedGroup(
  left: readonly JoinLine[],
  right: readonly JoinLine[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  invocation: JoinInvocation,
  output: JoinOutput,
): Promise<void> {
  const key = left[leftStart]?.key ?? "";
  for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
    for (let rightIndex = rightStart; rightIndex < rightEnd; rightIndex += 1) {
      const leftRecord = left[leftIndex];
      const rightRecord = right[rightIndex];
      if (leftRecord === undefined || rightRecord === undefined) continue;
      await output.emit(
        [
          key,
          ...leftRecord.fields.filter((_field, index) => index !== invocation.leftField - 1),
          ...rightRecord.fields.filter((_field, index) => index !== invocation.rightField - 1),
        ].join(invocation.delimiter),
      );
    }
  }
}

async function mergeJoin(
  left: readonly JoinLine[],
  right: readonly JoinLine[],
  invocation: JoinInvocation,
  output: JoinOutput,
): Promise<void> {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const order = joinOrder(left[leftIndex], right[rightIndex]);
    if (order < 0) {
      if (invocation.includeUnpaired.has(1)) await output.emit(left[leftIndex]?.text ?? "");
      leftIndex += 1;
      continue;
    }
    if (order > 0) {
      if (invocation.includeUnpaired.has(2)) await output.emit(right[rightIndex]?.text ?? "");
      rightIndex += 1;
      continue;
    }
    const key = left[leftIndex]?.key ?? "";
    const leftEnd = matchingEnd(left, leftIndex, key);
    const rightEnd = matchingEnd(right, rightIndex, key);
    await emitJoinedGroup(
      left,
      right,
      leftIndex,
      leftEnd,
      rightIndex,
      rightEnd,
      invocation,
      output,
    );
    leftIndex = leftEnd;
    rightIndex = rightEnd;
  }
}

export const joinCommand = /* @__PURE__ */ defineApplet(JOIN, async (context, argv, fds) => {
  const invocation = parseJoinInvocation(argv);
  const collected = await inputTexts(context, invocation.paths, fds[0]);
  try {
    const left = parseJoinLines(
      collected.value[0]?.text ?? "",
      invocation.leftField,
      1,
      invocation,
      context,
    );
    const right = parseJoinLines(
      collected.value[1]?.text ?? "",
      invocation.rightField,
      2,
      invocation,
      context,
    );
    const writer = new BufferedTextWriter(context, fds[1]);
    try {
      const output = new JoinOutput(writer, context.budget.limits.maxBufferedRecords);
      await mergeJoin(left, right, invocation, output);
      await writer.flush();
    } finally {
      writer.abort();
    }
    return 0;
  } finally {
    collected.release();
  }
});
