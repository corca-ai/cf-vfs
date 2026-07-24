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

function cellAt(cells: Uint32Array, index: number): number {
  const cell = cells[index];
  if (cell === undefined) throw new RangeError(`diff matrix index ${index} is out of bounds`);
  return cell;
}

function lineOperations(before: readonly string[], after: readonly string[]): LineDiffOperation[] {
  const columns = after.length + 1;
  const cells = (before.length + 1) * columns;
  if (cells > MAX_LCS_CELLS) {
    throw new VfsError("E2BIG", `diff requires ${cells} comparison cells; limit is ${MAX_LCS_CELLS}`);
  }
  const lengths = new Uint32Array(cells);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * columns + right;
      lengths[index] = lineAt(before, left) === lineAt(after, right)
        ? cellAt(lengths, (left + 1) * columns + right + 1) + 1
        : Math.max(
            cellAt(lengths, (left + 1) * columns + right),
            cellAt(lengths, index + 1),
          );
    }
  }

  const operations: LineDiffOperation[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      operations.push({
        kind: "equal",
        text: lineAt(before, left),
        oldLine: left + 1,
        newLine: right + 1,
      });
      left += 1;
      right += 1;
    } else if (
      left < before.length
      && (right >= after.length
        || cellAt(lengths, (left + 1) * columns + right)
          >= cellAt(lengths, left * columns + right + 1))
    ) {
      operations.push({
        kind: "delete",
        text: lineAt(before, left),
        oldLine: left + 1,
        newLine: right + 1,
      });
      left += 1;
    } else {
      operations.push({
        kind: "insert",
        text: lineAt(after, right),
        oldLine: left + 1,
        newLine: right + 1,
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

export function createLineDiff(before: string, after: string): LineDiff {
  if (before === after) return { changes: 0, operations: [] };
  const operations = lineOperations(
    splitLinesPreservingEndings(before),
    splitLinesPreservingEndings(after),
  );
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
    const start = index;
    for (;;) {
      const operation = diff.operations[index];
      if (!operation || operation.kind === "equal") break;
      index += 1;
    }
    const changed = diff.operations.slice(start, index);
    const first = changed.at(0);
    if (!first) throw new Error("diff hunk cannot be empty");
    const deleted = changed.filter((operation) => operation.kind === "delete");
    const inserted = changed.filter((operation) => operation.kind === "insert");
    output.push(
      `@@ -${first.oldLine},${deleted.length} +${first.newLine},${inserted.length} @@\n`,
    );
    for (const operation of changed) {
      if (operation.kind === "delete") output.push(prefixedLine("-", operation.text));
      if (operation.kind === "insert") output.push(prefixedLine("+", operation.text));
    }
  }
  return output.join("");
}
