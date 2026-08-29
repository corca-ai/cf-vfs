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

function prefixedLine(prefix: "-" | "+", text: string): string {
  return text.endsWith("\n")
    ? `${prefix}${text}`
    : `${prefix}${text}\n\\ No newline at end of file\n`;
}

function changedHunk(
  operations: readonly LineDiffOperation[],
  start: number,
): { readonly lines: string[]; readonly next: number } {
  let next = start;
  while (operations[next] !== undefined && operations[next]?.kind !== "equal") next += 1;
  const changed = operations.slice(start, next);
  const first = changed.at(0);
  if (!first) throw new Error("diff hunk cannot be empty");
  const deleted = changed.filter((operation) => operation.kind === "delete").length;
  const inserted = changed.filter((operation) => operation.kind === "insert").length;
  const lines = [`@@ -${first.oldLine},${deleted} +${first.newLine},${inserted} @@\n`];
  for (const operation of changed) {
    if (operation.kind === "delete") lines.push(prefixedLine("-", operation.text));
    if (operation.kind === "insert") lines.push(prefixedLine("+", operation.text));
  }
  return { lines, next };
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
  operations.push(
    ...lineOperations(
      beforeLines.slice(prefix, beforeLines.length - suffix),
      afterLines.slice(prefix, afterLines.length - suffix),
      prefix,
      prefix,
    ),
  );
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

export function renderLineDiff(from: string, to: string, diff: LineDiff): string {
  if (diff.changes === 0) return "";
  const output = [`--- ${from}\n`, `+++ ${to}\n`];
  let index = 0;
  while (index < diff.operations.length) {
    while (diff.operations[index]?.kind === "equal") index += 1;
    if (index >= diff.operations.length) break;
    const hunk = changedHunk(diff.operations, index);
    output.push(...hunk.lines);
    index = hunk.next;
  }
  return output.join("");
}
