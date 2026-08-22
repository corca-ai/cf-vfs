import { createLineDiff } from "../core/line-diff.js";
import type { TextEdit } from "./types.js";

/**
 * Derives the edits that turn `before` into `after`.
 *
 * This is what makes an external whole-text replacement mergeable. A shell
 * command hands the filesystem a complete file; applying that to a document as
 * a replacement would discard whatever else was being typed, so it is turned
 * back into the changes it represents and applied as those.
 *
 * Line-granular by construction, because it reuses the diff the repository
 * already has rather than adding a second one. That is coarser than a
 * character diff for an edit inside a line — the whole line is replaced — which
 * costs a little concurrency on the same line and nothing on different lines.
 * Worth knowing before building on it, and worth the reuse: a second diff
 * implementation is a second thing to keep correct.
 *
 * Common leading and trailing lines are skipped, so a one-line change in a
 * large file produces one small edit rather than a rewrite.
 */
export function textEdits(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  const diff = createLineDiff(before, after);
  const edits: TextEdit[] = [];
  let offset = 0;
  let pending: { offset: number; remove: number; insert: string } | undefined;
  const flush = (): void => {
    if (pending === undefined) return;
    if (pending.remove > 0 || pending.insert.length > 0) edits.push(pending);
    pending = undefined;
  };
  for (const operation of diff.operations) {
    if (operation.kind === "equal") {
      flush();
      offset += operation.text.length;
      continue;
    }
    // Adjacent deletes and inserts are one replacement. Emitting them
    // separately would be correct but would make a changed line read as a
    // removal followed by an unrelated insertion.
    pending ??= { offset, remove: 0, insert: "" };
    if (operation.kind === "delete") {
      pending.remove += operation.text.length;
      offset += operation.text.length;
      continue;
    }
    pending.insert += operation.text;
  }
  flush();
  return edits;
}

/**
 * Applies edits to a string, for a host that keeps plain text rather than a
 * merging document.
 *
 * Present so the contract has a reference implementation: an editor's document
 * type is its own, but a test — or a simple single-writer host — needs one
 * that is obviously right.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let result = "";
  let read = 0;
  for (const edit of edits) {
    result += text.slice(read, edit.offset);
    result += edit.insert;
    read = edit.offset + edit.remove;
  }
  return result + text.slice(read);
}
