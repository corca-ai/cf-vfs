import { VfsError } from "../core/errors.js";
import { applyTextEdits, textEdits } from "./edits.js";
import type { TextEdit } from "./types.js";

function same(left: TextEdit, right: TextEdit): boolean {
  return (
    left.offset === right.offset && left.remove === right.remove && left.insert === right.insert
  );
}
function overlaps(left: TextEdit, right: TextEdit): boolean {
  if (left.remove === 0 && right.remove === 0) return left.offset === right.offset;
  if (left.remove === 0)
    return left.offset >= right.offset && left.offset < right.offset + right.remove;
  if (right.remove === 0) return overlaps(right, left);
  return (
    Math.max(left.offset, right.offset) <
    Math.min(left.offset + left.remove, right.offset + right.remove)
  );
}
/** Preserve disjoint edits from a common base; leave both versions untouched on conflict. */
export function mergeText(base: string, local: string, incoming: string): string {
  if (local === base || local === incoming) return incoming;
  if (incoming === base) return local;
  const ours = textEdits(base, local);
  const combined = [...ours];
  for (const edit of textEdits(base, incoming)) {
    if (ours.some((left) => same(left, edit))) continue;
    if (ours.some((left) => overlaps(left, edit)))
      throw new VfsError("EREVISION", "concurrent document edits overlap");
    combined.push(edit);
  }
  combined.sort((left, right) => left.offset - right.offset);
  return applyTextEdits(base, combined);
}
