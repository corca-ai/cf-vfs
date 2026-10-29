import { VfsError } from "./errors.js";
import { splitLinesPreservingEndings } from "./lines.js";

const MAX_LCS_CELLS = 1_000_000;

interface LineDiffOperation {
  readonly kind: "equal" | "delete" | "insert";
  readonly text: string;
  readonly oldLine: number;
  readonly newLine: number;
}

export interface LineDiff {
  readonly changes: number;
  readonly operations: readonly LineDiffOperation[];
}

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) throw new RangeError(`line index ${index} is out of bounds`);
  return line;
}

function equalOperation(text: string, oldLine: number, newLine: number): LineDiffOperation {
  return { kind: "equal", text, oldLine, newLine };
}

function cellAt(cells: Uint32Array, index: number): number {
  const cell = cells[index];
  if (cell === undefined) throw new RangeError(`diff matrix index ${index} is out of bounds`);
  return cell;
}

function lcsLengths(before: readonly string[], after: readonly string[]): Uint32Array {
  const columns = after.length + 1;
  const cells = (before.length + 1) * columns;
  if (cells > MAX_LCS_CELLS) {
    throw new VfsError(
      "E2BIG",
      `diff requires ${cells} comparison cells; limit is ${MAX_LCS_CELLS}`,
    );
  }
  const lengths = new Uint32Array(cells);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * columns + right;
      lengths[index] =
        lineAt(before, left) === lineAt(after, right)
          ? cellAt(lengths, (left + 1) * columns + right + 1) + 1
          : Math.max(cellAt(lengths, (left + 1) * columns + right), cellAt(lengths, index + 1));
    }
  }
  return lengths;
}

function shouldDelete(
  lengths: Uint32Array,
  columns: number,
  left: number,
  right: number,
  afterLength: number,
): boolean {
  return (
    right >= afterLength ||
    cellAt(lengths, (left + 1) * columns + right) >= cellAt(lengths, left * columns + right + 1)
  );
}

function lineOperations(
  before: readonly string[],
  after: readonly string[],
  oldOffset = 0,
  newOffset = 0,
): LineDiffOperation[] {
  const columns = after.length + 1;
  const lengths = lcsLengths(before, after);

  const operations: LineDiffOperation[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      operations.push(
        equalOperation(lineAt(before, left), oldOffset + left + 1, newOffset + right + 1),
      );
      left += 1;
      right += 1;
    } else if (left < before.length && shouldDelete(lengths, columns, left, right, after.length)) {
      operations.push({
        kind: "delete",
        text: lineAt(before, left),
        oldLine: oldOffset + left + 1,
        newLine: newOffset + right + 1,
      });
      left += 1;
    } else {
      operations.push({
        kind: "insert",
        text: lineAt(after, right),
        oldLine: oldOffset + left + 1,
        newLine: newOffset + right + 1,
      });
      right += 1;
    }
  }
  return operations;
}

function prefixedLine(prefix: "-" | "+" | " ", text: string): string {
  return text.endsWith("\n")
    ? `${prefix}${text}`
    : `${prefix}${text}\n\\ No newline at end of file\n`;
}

/** Unchanged lines shown around each change, as `diff -u` and `git diff` default to. */
const CONTEXT_LINES = 3;

/** GNU's range: the count is omitted when it is one, and an empty range names the line before. */
function hunkRange(before: number, count: number): string {
  if (count === 1) return String(before + 1);
  return `${count === 0 ? before : before + 1},${count}`;
}

/** Index ranges of operations to show: each change widened by context, overlapping ones merged. */
function hunkSpans(operations: readonly LineDiffOperation[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  operations.forEach((operation, index) => {
    if (operation.kind === "equal") return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(operations.length, index + CONTEXT_LINES + 1);
    const last = spans.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = end;
    else spans.push([start, end]);
  });
  return spans;
}

export function createLineDiff(before: string, after: string): LineDiff {
  if (before === after) return { changes: 0, operations: [] };
  const beforeLines = splitLinesPreservingEndings(before);
  const afterLines = splitLinesPreservingEndings(after);
  const shared = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < shared && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const operations: LineDiffOperation[] = [];
  for (let index = 0; index < prefix; index += 1) {
    operations.push(equalOperation(lineAt(beforeLines, index), index + 1, index + 1));
  }
  for (const operation of lineOperations(
    beforeLines.slice(prefix, beforeLines.length - suffix),
    afterLines.slice(prefix, afterLines.length - suffix),
    prefix,
    prefix,
  ))
    operations.push(operation);
  for (let index = 0; index < suffix; index += 1) {
    operations.push(
      equalOperation(
        lineAt(beforeLines, beforeLines.length - suffix + index),
        beforeLines.length - suffix + index + 1,
        afterLines.length - suffix + index + 1,
      ),
    );
  }
  return {
    changes: operations.filter((operation) => operation.kind !== "equal").length,
    operations,
  };
}

function renderHunk(
  shown: readonly LineDiffOperation[],
  oldBefore: number,
  newBefore: number,
): string[] {
  const oldCount = shown.filter((operation) => operation.kind !== "insert").length;
  const newCount = shown.filter((operation) => operation.kind !== "delete").length;
  const lines = [`@@ -${hunkRange(oldBefore, oldCount)} +${hunkRange(newBefore, newCount)} @@\n`];
  for (const operation of shown) {
    const prefix = operation.kind === "delete" ? "-" : operation.kind === "insert" ? "+" : " ";
    lines.push(prefixedLine(prefix, operation.text));
  }
  return lines;
}

export function renderLineDiff(from: string, to: string, diff: LineDiff): string {
  if (diff.changes === 0) return "";
  const output = [`--- ${from}\n`, `+++ ${to}\n`];
  const { operations } = diff;
  let oldBefore = 0;
  let newBefore = 0;
  let cursor = 0;
  for (const [start, end] of hunkSpans(operations)) {
    for (; cursor < start; cursor += 1) {
      if (operations[cursor]?.kind !== "insert") oldBefore += 1;
      if (operations[cursor]?.kind !== "delete") newBefore += 1;
    }
    for (const line of renderHunk(operations.slice(start, end), oldBefore, newBefore)) {
      output.push(line);
    }
  }
  return output.join("");
}
