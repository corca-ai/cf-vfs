import { VfsError } from "../core/errors.js";
import type { EntryPage, PageOptions, VfsStat } from "../vfs/types.js";

/** Pages a small in-memory listing the way the filesystem pages its own. */
export function localEntryPage(entries: readonly VfsStat[], options?: PageOptions): EntryPage {
  if (
    options?.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit <= 0)
  ) {
    throw new VfsError("EINVAL", "limit must be a positive safe integer");
  }
  const cursor = options?.cursor ?? "";
  const remaining = entries.filter((entry) => entry.path > cursor);
  const limit = options?.limit ?? remaining.length;
  const kept = remaining.slice(0, limit);
  return {
    entries: kept,
    nextCursor: remaining.length > limit ? (kept.at(-1)?.path ?? null) : null,
    scanned: kept.length,
  };
}
