import { VfsError } from "./errors.js";
import { splitLinesPreservingEndings } from "./lines.js";

type PatchLineKind = "context" | "delete" | "insert";

interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface ApplyUnifiedPatchResult {
  text: string;
  hunks: number;
  additions: number;
  deletions: number;
}

function patchLines(patch: string): string[] {
  if (patch.length === 0) return [];
  const lines = splitLinesPreservingEndings(patch);
  if (!patch.endsWith("\n")) {
    throw new VfsError("EINVAL", "patch must end with a newline");
  }
  return lines;
}

function decimalValue(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VfsError("EINVAL", "patch hunk line numbers must be safe non-negative integers");
  }
  return parsed;
}

function parseHunks(patch: string): PatchHunk[] {
  const lines = patchLines(patch);
  if (!lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ ")) {
    throw new VfsError("EINVAL", "patch must start with --- and +++ headers");
  }

  const hunks: PatchHunk[] = [];
  let index = 2;
  while (index < lines.length) {
    const header = lines[index];
    const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[^\n]*)\n$/u);
    if (!match) throw new VfsError("EINVAL", `invalid patch hunk header at line ${index + 1}`);
    const hunk: PatchHunk = {
      oldStart: decimalValue(match[1]),
      oldCount: decimalValue(match[2], 1),
      newStart: decimalValue(match[3]),
      newCount: decimalValue(match[4], 1),
      lines: [],
    };
    index += 1;
    while (index < lines.length && !lines[index]?.startsWith("@@ ")) {
      const line = lines[index];
      if (line === undefined) break;
      if (line === "\\ No newline at end of file\n") {
        const previous = hunk.lines.at(-1);
        if (!previous || !previous.text.endsWith("\n")) {
          throw new VfsError("EINVAL", `misplaced no-newline marker at line ${index + 1}`);
        }
        previous.text = previous.text.slice(0, -1);
        index += 1;
        continue;
      }
      const prefix = line[0];
      const kind: PatchLineKind = prefix === " "
        ? "context"
        : prefix === "-"
          ? "delete"
          : prefix === "+"
            ? "insert"
            : (() => {
                throw new VfsError("EINVAL", `invalid patch line at line ${index + 1}`);
              })();
      hunk.lines.push({ kind, text: line.slice(1) });
      index += 1;
    }
    const oldCount = hunk.lines.filter((line) => line.kind !== "insert").length;
    const newCount = hunk.lines.filter((line) => line.kind !== "delete").length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
      throw new VfsError("EINVAL", "patch hunk line counts do not match its header");
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) throw new VfsError("EINVAL", "patch contains no hunks");
  return hunks;
}

function hunkIndex(start: number, count: number): number {
  if (start === 0 && count === 0) return 0;
  if (start < 1) throw new VfsError("EINVAL", "patch hunk line numbers are invalid");
  return start - 1;
}

export function applyUnifiedPatch(source: string, patch: string): ApplyUnifiedPatchResult {
  const sourceContent = splitLinesPreservingEndings(source);
  const output: string[] = [];
  const hunks = parseHunks(patch);
  let sourceIndex = 0;
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    const start = hunkIndex(hunk.oldStart, hunk.oldCount);
    if (start < sourceIndex || start > sourceContent.length) {
      throw new VfsError("EINVAL", "patch hunks are overlapping or outside the file");
    }
    output.push(...sourceContent.slice(sourceIndex, start));
    sourceIndex = start;
    if (hunkIndex(hunk.newStart, hunk.newCount) !== output.length) {
      throw new VfsError("EINVAL", "patch hunk new-file position is inconsistent");
    }

    for (const line of hunk.lines) {
      if (line.kind === "insert") {
        output.push(line.text);
        additions += 1;
        continue;
      }
      if (sourceContent[sourceIndex] !== line.text) {
        throw new VfsError("EREVISION", "patch context does not match the current file");
      }
      if (line.kind === "context") output.push(line.text);
      else deletions += 1;
      sourceIndex += 1;
    }
  }
  output.push(...sourceContent.slice(sourceIndex));
  return { text: output.join(""), hunks: hunks.length, additions, deletions };
}
