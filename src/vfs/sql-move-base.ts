import { VfsError } from "../core/errors.js";
import { basename, descendantRange, dirname, isDescendant } from "../core/path.js";
import { codePointLength } from "../core/unicode.js";
import { SqlMetadata } from "./sql-metadata-base.js";
import { type EntryRow, firstRow, integerColumn, type SqlRow } from "./sql-model.js";
import { EXECUTE_PERMISSION, type PosixAccessContext, WRITE_PERMISSION } from "./sql-posix.js";
import type { MoveOptions, MoveResult, RemoveOptions, RemoveResult } from "./types.js";

export abstract class SqlMove extends SqlMetadata {
  async remove(
    path: string,
    options: RemoveOptions = {},
    posix?: PosixAccessContext,
  ): Promise<RemoveResult> {
    // `rm link` removes the link. Following it would delete the target and
    // leave the link behind, which is the opposite of what was asked.
    const access = this.resolveAccess(path, false, false);
    const normalized = access.path;
    if (normalized === "/") throw new VfsError("EINVAL", "cannot remove root", normalized);
    const state = { queued: 0 };
    const result = this.transaction(() =>
      this.commitRemove(normalized, access.row, access.followed, options, posix, state),
    );
    if (state.queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }

  private commitRemove(
    path: string,
    resolved: EntryRow | null,
    followed: readonly string[],
    options: RemoveOptions,
    posix: PosixAccessContext | undefined,
    state: { queued: number },
  ): RemoveResult {
    // The row resolution already landed on, so a link whose target is
    // missing or cyclic is still removable — it is the link being removed.
    const root = resolved ?? this.requireEntry(path, false);
    this.assertTraverse(path, followed, posix);
    if (posix !== undefined) {
      const parent = this.requireDirectory(dirname(path));
      this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, path);
      this.assertStickyRemoval(parent, root, posix, path);
    }
    const range = descendantRange(path);
    const recursive = options.recursive ?? false;
    if (root.kind === "directory" && !recursive) {
      const hasDescendants = firstRow(
        this.sql.exec<SqlRow>(
          `SELECT 1 AS present FROM vfs_entries
           WHERE path >= ? AND path < ? LIMIT 1`,
          range.lower,
          range.upper,
        ),
      );
      if (hasDescendants !== undefined) {
        throw new VfsError("ENOTEMPTY", "directory is not empty", path);
      }
    }
    if (root.kind === "directory" && recursive) {
      this.assertSubtreePermissions(path, posix, 0, WRITE_PERMISSION | EXECUTE_PERMISSION);
      this.assertSubtreeSticky(path, posix);
    }
    const summary =
      root.kind === "directory" && recursive
        ? this.aggregateSubtree(path)
        : {
            entries: 1,
            inlineBytes: root.contentClass === "inline" ? root.sizeBytes : 0,
          };
    const now = this.now();
    this.publishSubtreeRemoval(path);
    this.sql.exec(
      `INSERT INTO vfs_gc_queue (
         r2_key, not_before_ms, attempts, next_attempt_at_ms, last_error
       )
       SELECT o.r2_key, MAX(?, o.retain_until_ms), 0,
              MAX(?, o.retain_until_ms), NULL
       FROM vfs_opaque_objects o
       WHERE EXISTS (
         SELECT 1 FROM vfs_entries removed
         WHERE removed.opaque_object_id = o.id
           AND (removed.path = ? OR (removed.path >= ? AND removed.path < ?))
       )
       AND NOT EXISTS (
         SELECT 1 FROM vfs_entries retained
         WHERE retained.opaque_object_id = o.id
           AND NOT (retained.path = ? OR (retained.path >= ? AND retained.path < ?))
       )
       ON CONFLICT(r2_key) DO UPDATE SET
         not_before_ms = MAX(vfs_gc_queue.not_before_ms, excluded.not_before_ms),
         next_attempt_at_ms = MAX(
           vfs_gc_queue.next_attempt_at_ms,
           excluded.not_before_ms
         )`,
      now,
      now,
      path,
      range.lower,
      range.upper,
      path,
      range.lower,
      range.upper,
    );
    state.queued = integerColumn(this.sql.exec<SqlRow>("SELECT changes() AS value").one(), "value");
    this.sql.exec(
      `DELETE FROM vfs_inline_chunks
       WHERE entry_id IN (
         SELECT id FROM vfs_entries
         WHERE path = ? OR (path >= ? AND path < ?)
       )`,
      path,
      range.lower,
      range.upper,
    );
    this.sql.exec(
      `DELETE FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)`,
      path,
      range.lower,
      range.upper,
    );
    // A set-based delete does not report what it removed, so the link count
    // is recomputed on demand rather than tracked here.
    this.symlinkCountStale = true;
    this.sql.exec(
      `DELETE FROM vfs_opaque_objects
       WHERE NOT EXISTS (
         SELECT 1 FROM vfs_entries
         WHERE opaque_object_id = vfs_opaque_objects.id
       )
       AND EXISTS (
         SELECT 1 FROM vfs_gc_queue
         WHERE r2_key = vfs_opaque_objects.r2_key
       )`,
    );
    this.updateUsage(-summary.inlineBytes, -summary.entries);
    // Recorded here rather than in `publishSubtreeRemoval`, which cannot
    // know whether it is publishing one path or a range, and which `move`
    // calls twice for what is a single change.
    this.recordMutation(
      summary.entries > 1
        ? { op: "remove", path, subtree: { root: path } }
        : { op: "remove", path },
    );
    return {
      removed: summary.entries,
      opaqueObjectsQueuedForDeletion: state.queued,
    };
  }

  async move(
    from: string,
    to: string,
    options: MoveOptions = {},
    posix?: PosixAccessContext,
  ): Promise<MoveResult> {
    // Both ends name the link itself: renaming a link moves the link.
    const sourceAccess = this.resolveAccess(from, false, false);
    const source = sourceAccess.path;
    const targetAccess = this.resolveAccess(to, true, false);
    const target = targetAccess.path;
    if (source === "/") throw new VfsError("EINVAL", "cannot move root", source);
    if (source === target) {
      return this.transaction(() => {
        const entry = sourceAccess.row ?? this.requireEntry(source, false);
        this.assertTraverse(source, sourceAccess.followed, posix);
        if (posix !== undefined) {
          const parent = this.requireDirectory(dirname(source));
          this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, source);
          this.assertStickyRemoval(parent, entry, posix, source);
        }
        return { from: source, to: target, moved: 1, replaced: false };
      });
    }
    const state = { queued: 0 };
    const result = this.transaction(() =>
      this.commitMove(
        source,
        target,
        sourceAccess.row,
        sourceAccess.followed,
        targetAccess.row,
        targetAccess.followed,
        options,
        posix,
        state,
      ),
    );
    if (state.queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }

  private commitMove(
    source: string,
    target: string,
    sourceResolved: EntryRow | null,
    sourceFollowed: readonly string[],
    targetResolved: EntryRow | null,
    targetFollowed: readonly string[],
    options: MoveOptions,
    posix: PosixAccessContext | undefined,
    state: { queued: number },
  ): MoveResult {
    const sourceEntry = sourceResolved ?? this.requireEntry(source, false);
    if (sourceEntry.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory into itself", target);
    }
    this.assertTraverse(source, sourceFollowed, posix);
    this.assertTraverse(target, targetFollowed, posix);
    const targetParent = this.requireDirectory(dirname(target));
    if (posix !== undefined) {
      const sourceParent = this.requireDirectory(dirname(source));
      this.assertPermission(sourceParent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, source);
      this.assertPermission(targetParent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, target);
      this.assertStickyRemoval(sourceParent, sourceEntry, posix, source);
    }
    const destination = targetResolved ?? this.oneEntry(target);
    if (destination !== null && posix !== undefined) {
      this.assertStickyRemoval(targetParent, destination, posix, target);
    }
    this.assertDestinationReplaceable(destination, target, options.replace ?? false);
    // A directory and a non-directory cannot replace each other. A link can
    // be replaced by anything and can replace anything that is not a
    // directory, because it is one entry holding text — `mv file link`
    // replaces the link, as it does elsewhere.
    const directoryMismatch =
      destination !== null &&
      (destination.kind === "directory") !== (sourceEntry.kind === "directory");
    if (directoryMismatch && destination !== null) {
      throw new VfsError(
        destination.kind === "directory" ? "EISDIR" : "ENOTDIR",
        "source and destination kinds differ",
        target,
      );
    }
    // A path's revision never goes backwards. What lands on an occupied path
    // takes one past whatever was there, so a holder of the old number
    // cannot see it come round again. Only the root of what arrives can land
    // on an occupied path -- a non-empty directory cannot be replaced, so
    // every descendant lands somewhere that was absent.
    const sourceRange = descendantRange(source);
    const now = this.now();
    if (destination !== null) state.queued += this.removeExact(target, now, false);
    const sourceChangeSeq = this.nextChangeSeq();
    this.publishSubtreeRemoval(source, sourceChangeSeq);
    this.sql.exec(
      `UPDATE vfs_entries SET
         mutation_version = COALESCE((
           SELECT version + 1 FROM vfs_path_tombstones
           WHERE path = ? || substr(vfs_entries.path, ?)
         ), 1),
         path = ? || substr(path, ?),
         parent_path = CASE WHEN path = ? THEN ?
           ELSE ? || substr(parent_path, ?) END,
         name = CASE WHEN path = ? THEN ? ELSE name END,
         modified_at_ms = CASE WHEN path = ? THEN ? ELSE modified_at_ms END,
         revision = CASE WHEN path = ? THEN MAX(revision, ?) + 1 ELSE revision + 1 END
       WHERE path = ? OR (path >= ? AND path < ?)`,
      target,
      codePointLength(source) + 1,
      target,
      codePointLength(source) + 1,
      source,
      dirname(target),
      target,
      codePointLength(source) + 1,
      source,
      basename(target),
      source,
      now,
      source,
      destination?.revision ?? 0,
      source,
      sourceRange.lower,
      sourceRange.upper,
    );
    // Keep this immediately after the UPDATE: changes() reports that statement.
    const moved = integerColumn(this.sql.exec<SqlRow>("SELECT changes() AS value").one(), "value");
    this.clearSubtreeTombstones(target);
    this.recordPresentSubtree(target, this.nextChangeSeq());
    // One change, though two ranges were republished. A move is a prefix
    // rename, so `root` and `to` are enough for a consumer to recompute
    // every path it holds without being told them.
    this.recordMutation({
      op: "move",
      path: source,
      subtree: { root: source, to: target },
    });
    return {
      from: source,
      to: target,
      moved,
      replaced: destination !== null,
    };
  }
}
