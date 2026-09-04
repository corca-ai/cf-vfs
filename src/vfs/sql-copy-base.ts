import { VfsError } from "../core/errors.js";
import { basename, descendantRange, dirname, isDescendant } from "../core/path.js";
import { codePointLength } from "../core/unicode.js";
import type { CreationParents, EntryRow } from "./sql-model.js";
import { SqlMove } from "./sql-move-base.js";
import {
  EXECUTE_PERMISSION,
  type PosixAccessContext,
  READ_PERMISSION,
  SETGID_BIT,
} from "./sql-posix.js";
import type { CopyOptions, CopyResult, SubtreeSummary } from "./types.js";

interface CopyPlan {
  readonly destination: EntryRow | null;
  readonly now: number;
  readonly targetParent: EntryRow | undefined;
  readonly owner: { readonly uid: number; readonly gid: number };
  readonly sourceRange: { readonly lower: string; readonly upper: string };
  readonly summary: SubtreeSummary;
  readonly inoBase: number;
  readonly rootRevision: number;
  readonly changeSeq: number;
}

export abstract class SqlCopy extends SqlMove {
  async copy(
    from: string,
    to: string,
    options: CopyOptions = {},
    posix?: PosixAccessContext,
  ): Promise<CopyResult> {
    // A link is copied as a link, target text and all: reading through it
    // would turn one entry into a second copy of a possibly enormous file, and
    // a recursive copy would do that for every link in the subtree. Only the
    // named source can be dereferenced, and only when asked.
    const sourceAccess = this.resolveAccess(from, false, options.dereference ?? false);
    const source = sourceAccess.path;
    const targetAccess = this.resolveAccess(to, true, false);
    const target = targetAccess.path;
    const state = { queued: 0 };
    const result = this.transaction(() =>
      this.commitCopy(
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

  private commitCopy(
    source: string,
    target: string,
    sourceResolved: EntryRow | null,
    sourceFollowed: readonly string[],
    targetResolved: EntryRow | null,
    targetFollowed: readonly string[],
    options: CopyOptions,
    posix: PosixAccessContext | undefined,
    state: { queued: number },
  ): CopyResult {
    const sourceEntry = sourceResolved ?? this.requireEntry(source, false);
    this.assertCopySource(source, target, sourceEntry, sourceFollowed, options, posix);
    const plan = this.prepareCopy(
      source,
      target,
      sourceEntry,
      targetResolved,
      targetFollowed,
      options,
      posix,
      state,
    );
    this.insertCopyRows(source, target, plan, posix);
    return this.finishCopy(source, target, plan);
  }

  private assertCopySource(
    source: string,
    target: string,
    sourceEntry: EntryRow,
    sourceFollowed: readonly string[],
    options: CopyOptions,
    posix: PosixAccessContext | undefined,
  ): void {
    if (source === target) {
      throw new VfsError("EINVAL", "source and destination are the same path", target);
    }
    this.assertTraverse(source, sourceFollowed, posix);
    if (sourceEntry.kind === "file") {
      this.assertPermission(sourceEntry, posix, READ_PERMISSION, source);
    } else if (sourceEntry.kind === "directory") {
      this.assertSubtreePermissions(
        source,
        posix,
        READ_PERMISSION,
        READ_PERMISSION | EXECUTE_PERMISSION,
      );
    }
    if (sourceEntry.kind === "directory" && !(options.recursive ?? false)) {
      throw new VfsError("EISDIR", "recursive copy is required for directories", source);
    }
    if (sourceEntry.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot copy a directory into itself", target);
    }
  }

  private prepareCopy(
    source: string,
    target: string,
    sourceEntry: EntryRow,
    targetResolved: EntryRow | null,
    targetFollowed: readonly string[],
    options: CopyOptions,
    posix: PosixAccessContext | undefined,
    state: { queued: number },
  ): CopyPlan {
    const parents = this.copyCreationParents(target, targetFollowed, options, posix);
    const destination = targetResolved ?? this.oneEntry(target);
    this.assertDestinationReplaceable(destination, target, options.replace ?? false);
    const now = this.now();
    const preparedParent = this.createCopyParent(
      target,
      targetFollowed,
      options,
      posix,
      parents,
      now,
    );
    if (destination !== null && posix !== undefined) {
      this.assertStickyRemoval(preparedParent, destination, posix, target);
    }
    const targetParent = posix === undefined ? undefined : preparedParent;
    const owner =
      targetParent === undefined ? { uid: 0, gid: 0 } : this.creationOwner(targetParent, posix);
    const sourceRange = descendantRange(source);
    const summary = this.aggregateSubtree(source);
    const replacedInlineBytes = destination?.contentClass === "inline" ? destination.sizeBytes : 0;
    this.assertCapacity(
      summary.inlineBytes - replacedInlineBytes,
      summary.entries - (destination === null ? 0 : 1),
      target,
    );
    if (destination !== null) state.queued += this.removeExact(target, now, false);
    const changeSeq = this.nextChangeSeq();
    // Copying one file over another keeps the destination's identity, the
    // way `cp` keeps its inode: it opens the destination and writes through
    // it, and unlinking first is what `--remove-destination` is for. That
    // also makes `cp x y` and `cat x > y` agree, which a caller keying
    // durable state to an identity cannot be expected to hold apart.
    //
    // Anything else is a replacement and issues new identities: a recursive
    // copy is `cp -r`, which unlinks what it cannot open through, and a
    // directory or a link is not a file whose content was rewritten.
    // `ROW_NUMBER()` starts at one, so the base is one below the first
    // identity the run should use.
    const inoBase = this.copyInoBase(sourceEntry, destination, summary.entries);
    // A path's revision never goes backwards. Only the copy's root can land
    // on an occupied path -- a non-empty directory cannot be replaced, so
    // every descendant lands somewhere that was absent and starts at one.
    // A fresh entry would be one, and the destination is at least one, so
    // the general rule collapses to one past what was there.
    const rootRevision = (destination?.revision ?? 0) + 1;
    return {
      destination,
      now,
      targetParent,
      owner,
      sourceRange,
      summary,
      inoBase,
      rootRevision,
      changeSeq,
    };
  }

  private copyCreationParents(
    target: string,
    followed: readonly string[],
    options: CopyOptions,
    posix: PosixAccessContext | undefined,
  ): CreationParents | undefined {
    if (posix === undefined) return undefined;
    const parents = this.creationParents(target, options.createParents ?? false);
    this.assertCreationAccess(target, followed, posix, parents.existing);
    return parents;
  }

  private createCopyParent(
    target: string,
    followed: readonly string[],
    options: CopyOptions,
    posix: PosixAccessContext | undefined,
    parents: CreationParents | undefined,
    now: number,
  ): EntryRow {
    return parents === undefined
      ? this.prepareParents(target, options.createParents ?? false, now, followed, posix)
      : this.createMissingParents(target, now, posix, parents);
  }

  private copyInoBase(source: EntryRow, destination: EntryRow | null, entries: number): number {
    const preserved =
      destination?.kind === "file" && source.kind === "file" ? destination.id : undefined;
    return (preserved ?? this.allocateIno(entries)) - 1;
  }

  private insertCopyRows(
    source: string,
    target: string,
    plan: CopyPlan,
    posix: PosixAccessContext | undefined,
  ): void {
    if (posix === undefined) this.insertTrustedCopyRows(source, target, plan);
    else this.insertPosixCopyRows(source, target, plan, posix);
  }

  private insertTrustedCopyRows(source: string, target: string, plan: CopyPlan): void {
    this.sql.exec(
      `INSERT INTO vfs_entries (
         id, path, parent_path, name, kind, content_class, opaque_object_id,
         link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
         mutation_version
       )
       SELECT
         ? + ROW_NUMBER() OVER (ORDER BY e.path),
         ? || substr(e.path, ?),
         CASE WHEN e.path = ? THEN ?
           ELSE ? || substr(e.parent_path, ?) END,
         CASE WHEN e.path = ? THEN ? ELSE e.name END,
         e.kind, e.content_class, e.opaque_object_id,
         e.link_target, e.size_bytes, e.mode, e.uid, e.gid, ?, ?,
         CASE WHEN e.path = ? THEN ? ELSE 1 END,
         COALESCE((
           SELECT version + 1 FROM vfs_path_tombstones
           WHERE path = ? || substr(e.path, ?)
         ), 1)
       FROM vfs_entries e
       WHERE e.path = ? OR (e.path >= ? AND e.path < ?)`,
      plan.inoBase,
      target,
      codePointLength(source) + 1,
      source,
      dirname(target),
      target,
      codePointLength(source) + 1,
      source,
      basename(target),
      plan.now,
      plan.now,
      source,
      plan.rootRevision,
      target,
      codePointLength(source) + 1,
      source,
      plan.sourceRange.lower,
      plan.sourceRange.upper,
    );
  }

  /** Copies actor-owned rows while carrying setgid inheritance through the tree. */
  private insertPosixCopyRows(
    source: string,
    target: string,
    plan: CopyPlan,
    posix: PosixAccessContext,
  ): void {
    // The trusted branch deliberately keeps its original range-copy query and
    // exact SQL cost; only this credential-bound branch needs the recursive CTE.
    this.sql.exec(
      `WITH RECURSIVE copied (
           path, parent_path, name, kind, content_class, opaque_object_id,
           link_target, size_bytes, copied_mode, copied_uid, copied_gid
         ) AS (
           SELECT
             e.path, e.parent_path, e.name, e.kind, e.content_class,
             e.opaque_object_id, e.link_target, e.size_bytes,
             CASE WHEN e.kind = 'symlink' THEN e.mode ELSE
               (e.mode & ?) |
               CASE WHEN e.kind = 'directory' AND (? & ?) <> 0 THEN ? ELSE 0 END
             END,
             ?,
             ?
           FROM vfs_entries e INDEXED BY vfs_entries_path
           WHERE e.path = ?
           UNION ALL
           SELECT
             e.path, e.parent_path, e.name, e.kind, e.content_class,
             e.opaque_object_id, e.link_target, e.size_bytes,
             CASE WHEN e.kind = 'symlink' THEN e.mode ELSE
               (e.mode & ?) |
               CASE
                 WHEN e.kind = 'directory' AND (parent.copied_mode & ?) <> 0 THEN ?
                 ELSE 0
               END
             END,
             ?,
             CASE
               WHEN (parent.copied_mode & ?) <> 0 THEN parent.copied_gid
               ELSE ?
             END
           FROM vfs_entries e INDEXED BY vfs_entries_parent_name
           JOIN copied parent ON e.parent_path = parent.path
         )
         INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           mutation_version
         )
         SELECT
           ? + ROW_NUMBER() OVER (ORDER BY copied.path),
           ? || substr(copied.path, ?),
           CASE WHEN copied.path = ? THEN ?
             ELSE ? || substr(copied.parent_path, ?) END,
           CASE WHEN copied.path = ? THEN ? ELSE copied.name END,
           copied.kind, copied.content_class, copied.opaque_object_id,
           copied.link_target, copied.size_bytes,
           copied.copied_mode, copied.copied_uid, copied.copied_gid, ?, ?,
           CASE WHEN copied.path = ? THEN ? ELSE 1 END,
           COALESCE((
             SELECT version + 1 FROM vfs_path_tombstones
             WHERE path = ? || substr(copied.path, ?)
           ), 1)
         FROM copied`,
      ~posix.umask,
      plan.targetParent?.mode ?? 0,
      SETGID_BIT,
      SETGID_BIT,
      plan.owner.uid,
      plan.owner.gid,
      source,
      ~posix.umask,
      SETGID_BIT,
      SETGID_BIT,
      posix.credentials.uid,
      SETGID_BIT,
      posix.credentials.gid,
      plan.inoBase,
      target,
      codePointLength(source) + 1,
      source,
      dirname(target),
      target,
      codePointLength(source) + 1,
      source,
      basename(target),
      plan.now,
      plan.now,
      source,
      plan.rootRevision,
      target,
      codePointLength(source) + 1,
    );
  }

  private finishCopy(source: string, target: string, plan: CopyPlan): CopyResult {
    this.clearSubtreeTombstones(target);
    this.recordPresentSubtree(target, plan.changeSeq);
    this.sql.exec(
      `INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body)
       SELECT destination.id, chunk.chunk_index, chunk.body
       FROM vfs_inline_chunks chunk
       JOIN vfs_entries source_entry ON source_entry.id = chunk.entry_id
       JOIN vfs_entries destination
         ON destination.path = ? || substr(source_entry.path, ?)
       WHERE source_entry.path = ?
          OR (source_entry.path >= ? AND source_entry.path < ?)`,
      target,
      codePointLength(source) + 1,
      source,
      plan.sourceRange.lower,
      plan.sourceRange.upper,
    );
    // The copy is set-based and carries `kind` across, so it may have
    // produced links; the count is recomputed rather than guessed.
    this.symlinkCountStale = true;
    // Only what the copy added. The two expressions differ on purpose:
    // `assertCapacity` runs before the destination is removed, so it has to
    // predict the end state and subtract what the removal will give back;
    // this runs after, and `removeExact` has already applied that half.
    // Reusing the net delta here would subtract the destination twice.
    this.updateUsage(plan.summary.inlineBytes, plan.summary.entries);
    // A copy publishes entries at the destination and leaves the source
    // alone, so what a consumer has to reflect is a create at `to`.
    this.recordMutation(
      plan.summary.entries > 1
        ? { op: "create", path: target, subtree: { root: target } }
        : { op: "create", path: target },
    );
    return {
      from: source,
      to: target,
      copied: plan.summary.entries,
      replaced: plan.destination !== null,
      opaqueBodiesCopied: 0 as const,
    };
  }
}
