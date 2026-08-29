import { VfsError } from "../core/errors.js";
import { basename, dirname } from "../core/path.js";
import { FILE_MODE } from "./config.js";
import {
  type CollectedWrite,
  type EntryRow,
  firstRow,
  type InlineWriteOutcome,
  type InlineWritePlan,
  integerColumn,
  nullableIntegerColumn,
  type OpaqueObjectRow,
  parseOpaqueObject,
  parseUpload,
  type SqlRow,
  stringColumn,
  type UploadRow,
} from "./sql-model.js";
import type { PosixAccessContext } from "./sql-posix.js";
import { SqlRead } from "./sql-read-base.js";
import type { WriteFilesOptions, WriteResult } from "./types.js";

interface InlineCommitState {
  readonly current: EntryRow | null;
  readonly parent: EntryRow | undefined;
}

interface InlineMutationPlan {
  readonly owner: { readonly uid: number; readonly gid: number };
  readonly mode: number;
  readonly inlineDelta: number;
  readonly entryDelta: number;
  readonly mutationVersion: number;
}

export abstract class SqlWritePlan extends SqlRead {
  protected opaqueObject(id: number): OpaqueObjectRow | null {
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT id, r2_key, size_bytes, etag, r2_version, verified_sha256,
              content_type, retain_until_ms
       FROM vfs_opaque_objects WHERE id = ?`,
        id,
      ),
    );
    return row === undefined ? null : parseOpaqueObject(row);
  }

  protected upload(id: string): UploadRow | null {
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT id, path, expected_mutation_token, r2_key, state,
              verification_token, expected_size_bytes, expires_at_ms,
              verification_lease_until_ms, create_parents, mode,
              content_type, receipt_json
       FROM vfs_upload_sessions WHERE id = ?`,
        id,
      ),
    );
    return row === undefined ? null : parseUpload(row);
  }

  protected queueGarbage(objectKey: string, notBeforeMs: number): void {
    this.sql.exec(
      `INSERT INTO vfs_gc_queue (
         r2_key, not_before_ms, attempts, next_attempt_at_ms, last_error
       ) VALUES (?, ?, 0, ?, NULL)
       ON CONFLICT(r2_key) DO UPDATE SET
         not_before_ms = MAX(vfs_gc_queue.not_before_ms, excluded.not_before_ms),
         next_attempt_at_ms = MAX(vfs_gc_queue.next_attempt_at_ms, excluded.not_before_ms)`,
      objectKey,
      notBeforeMs,
      notBeforeMs,
    );
  }

  protected queueUploadGarbage(session: UploadRow, now: number): void {
    this.queueGarbage(
      session.objectKey,
      Math.max(now, session.expiresAtMs + this.uploadSettlementGraceMs),
    );
  }

  protected queueObjectIfUnreferenced(objectId: number, now: number): boolean {
    const object = firstRow(
      this.sql.exec<SqlRow>(
        "DELETE FROM vfs_opaque_objects WHERE id=? AND NOT EXISTS(SELECT 1 FROM vfs_entries WHERE opaque_object_id=?) RETURNING r2_key,retain_until_ms",
        objectId,
        objectId,
      ),
    );
    if (object === undefined) return false;
    this.queueGarbage(
      stringColumn(object, "r2_key"),
      Math.max(now, integerColumn(object, "retain_until_ms")),
    );
    return true;
  }

  /**
   * Deletes one entry and accounts for it. The usage write is this method's
   * own, so a caller that replaces an entry adds only what it inserted --
   * subtracting the removal again double-counts it.
   */
  protected removeExact(path: string, now: number, bumpPath = true): number {
    const entry = this.oneEntry(path);
    if (entry === null) return 0;
    if (entry.contentClass === "inline") {
      this.sql.exec("DELETE FROM vfs_inline_chunks WHERE entry_id = ?", entry.id);
    }
    this.sql.exec("DELETE FROM vfs_entries WHERE id = ?", entry.id);
    if (entry.kind === "symlink") this.symlinkCountStale = true;
    const mutationVersion = entry.mutationVersion + (bumpPath ? 1 : 0);
    this.sql.exec(
      `INSERT INTO vfs_path_tombstones (path, version) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET version = MAX(version, excluded.version)`,
      path,
      mutationVersion,
    );
    if (bumpPath) this.publishToken(path, mutationVersion, false, "remove");
    this.updateUsage(entry.contentClass === "inline" ? -entry.sizeBytes : 0, -1);
    if (
      entry.contentClass === "opaque" &&
      entry.opaqueObjectId !== null &&
      this.queueObjectIfUnreferenced(entry.opaqueObjectId, now)
    )
      return 1;
    return 0;
  }

  /**
   * Arms the maintenance alarm without taking the object's alarm away from its
   * host.
   *
   * One Durable Object has one alarm, and the documented composition — this
   * filesystem held by a host class that owns `alarm()` — means the slot is
   * shared. There is no way to ask whether the alarm currently set is this
   * filesystem's own, so the rule is earliest-wins in both directions: an
   * existing alarm is never moved later, and no alarm is ever deleted.
   *
   * Deleting is the one that has to go even though it looks safe. Maintenance
   * work disappears while a host timer is pending far more often than the
   * reverse, and clearing it there stops a timer whose owner has no way to
   * discover that it stopped. What it costs instead is one spurious wake-up:
   * the alarm fires, finds nothing due, and re-arms to whatever is next.
   *
   * Leaving an earlier host alarm in place also means maintenance is not armed
   * until something re-arms it, which is why every exit from `drainGarbage()`
   * calls this. A host that owns `alarm()` must run maintenance from it, as
   * `VfsDurableObject` does and the README shows.
   */
  protected async scheduleGarbageAlarm(): Promise<void> {
    const row = this.sql
      .exec<SqlRow>(
        `SELECT MIN(due) AS due FROM (
         SELECT MAX(not_before_ms, next_attempt_at_ms) AS due FROM vfs_gc_queue
         UNION ALL
         SELECT expires_at_ms AS due FROM vfs_upload_sessions WHERE state = 'open'
         UNION ALL
         SELECT verification_lease_until_ms AS due
         FROM vfs_upload_sessions WHERE state = 'verifying'
         UNION ALL
         SELECT expires_at_ms AS due FROM vfs_upload_sessions WHERE state = 'committed'
       )`,
      )
      .one();
    const due = nullableIntegerColumn(row, "due");
    if (due === null) return;
    const current = await this.storage.getAlarm();
    if (current === null || due < current) await this.storage.setAlarm(due);
  }

  /**
   * Everything a write can decide before it holds any bytes.
   *
   * Split out so that a batch is refused for a bad disposition, a stale guard,
   * or a permission on its twelfth entry without having buffered its first,
   * and so that both forms decide those questions in one place rather than
   * two. `entry` carries what describes the file and `options` what describes
   * the call; a single write passes its options as both, which is exactly the
   * split a batch makes explicit.
   */
  protected planInlineWrite(
    path: string,
    entry: { ifMutationToken?: string; mode?: number },
    options: WriteFilesOptions,
    posix: PosixAccessContext | undefined,
    snapshot?: EntryRow,
  ): InlineWritePlan {
    const access =
      snapshot === undefined
        ? this.resolveAccess(path, true)
        : { path: snapshot.path, row: snapshot, followed: [] };
    const normalized = access.path;
    const state =
      access.row === null
        ? this.pathState(normalized)
        : { entry: access.row, mutationToken: access.row.mutationToken };
    const before = state.entry;
    const createParents = options.createParents ?? false;
    this.assertWriteAccess(normalized, before, createParents, access.followed, posix);
    const disposition = options.disposition ?? "upsert";
    if (disposition === "create" && before !== null) {
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    if (disposition === "replace" && before === null) {
      throw new VfsError("ENOENT", "no such file", normalized);
    }
    if (before?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    this.validateGuard(normalized, before, entry, path);
    return {
      written: path,
      path: normalized,
      followed: access.followed,
      createParents,
      disposition,
      skipIfUnchanged: options.skipIfUnchanged === true,
      mode: entry.mode,
      guard: entry,
      capturedToken: state.mutationToken,
      capturedEntry: before,
      ...(snapshot === undefined ? {} : { conditionalMutationVersion: snapshot.mutationVersion }),
    };
  }

  /**
   * Publishes one collected body, inside a transaction the caller already owns.
   *
   * Split out of `writeFile` so that `writeFiles` commits this same step once
   * per entry rather than a second implementation of it. That is what makes
   * "a batch costs a single write nothing" structural rather than a promise:
   * the single-path form runs this code, so its statement, row-read, and
   * row-written counts cannot move because a batch exists.
   *
   * `pending` is a batch's running capacity delta. A single write leaves it
   * undefined and validates its own growth here, before the insert it guards.
   * A batch accumulates instead and weighs the whole set once, which is a
   * different answer rather than a cheaper one -- see `assertCapacityFrom`.
   * Ordering inside the transaction is free either way: whichever entry is
   * refused, every one of them rolls back.
   */
  protected commitInlineWrite(
    plan: InlineWritePlan,
    chunks: readonly Uint8Array[],
    sizeBytes: number,
    digest: string | undefined,
    now: number,
    posix: PosixAccessContext | undefined,
    pending?: { inlineBytes: number; entries: number },
    revalidate = true,
  ): InlineWriteOutcome {
    let current = plan.capturedEntry;
    if (revalidate) {
      const state = this.pathState(plan.path);
      if (state.mutationToken !== plan.capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", plan.path);
      }
      this.validateGuard(plan.path, state.entry, plan.guard, plan.written);
      current = state.entry;
    }
    if (current?.kind === "directory") throw new VfsError("EISDIR", "is a directory", plan.path);
    const parent =
      current === null && (posix !== undefined || dirname(plan.path) !== "/")
        ? this.prepareParents(plan.path, plan.createParents, now, plan.followed, posix)
        : undefined;
    if (current !== null && revalidate) {
      this.assertWriteAccess(plan.path, current, false, plan.followed, posix);
    }
    const state = { current, parent };
    const unchanged = this.unchangedInlineWrite(plan, current, chunks, sizeBytes, digest);
    if (unchanged !== null) return unchanged;
    const mutation = this.inlineMutationPlan(plan, state, sizeBytes, posix, pending);
    if (
      current?.contentClass === "inline" &&
      chunks.length < Math.ceil(current.sizeBytes / this.chunkBytes)
    ) {
      this.sql.exec(
        "DELETE FROM vfs_inline_chunks WHERE entry_id = ? AND chunk_index >= ?",
        current.id,
        chunks.length,
      );
    }
    const written = this.writeInlineEntry(plan, current, mutation, sizeBytes, digest, now);
    if (written === undefined) {
      this.planInlineWrite(
        plan.written,
        plan.guard,
        {
          createParents: plan.createParents,
          disposition: plan.disposition,
          skipIfUnchanged: plan.skipIfUnchanged,
        },
        posix,
      );
      throw new VfsError("EREVISION", "path changed after it was read", plan.path);
    }
    return this.finishInlineWrite(plan, current, mutation, written, chunks, sizeBytes, now);
  }

  /** Returns only after all failures that an unchanged write must still expose. */
  private unchangedInlineWrite(
    plan: InlineWritePlan,
    current: EntryRow | null,
    chunks: readonly Uint8Array[],
    sizeBytes: number,
    digest: string | undefined,
  ): InlineWriteOutcome | null {
    if (!plan.skipIfUnchanged || current?.contentClass !== "inline") return null;
    if (current.sizeBytes !== sizeBytes) return null;
    if (plan.mode !== undefined && plan.mode !== current.mode) return null;
    if (!this.bodyIsUnchanged(current.id, current.revision, chunks, digest)) return null;
    return {
      result: {
        path: plan.path,
        revision: current.revision,
        mutationToken: plan.capturedToken,
        sizeBytes,
        created: false,
      },
      queuedGarbage: false,
    };
  }

  private inlineMutationPlan(
    plan: InlineWritePlan,
    state: InlineCommitState,
    sizeBytes: number,
    posix: PosixAccessContext | undefined,
    pending: { inlineBytes: number; entries: number } | undefined,
  ): InlineMutationPlan {
    const { current, parent } = state;
    const owner =
      current !== null
        ? { uid: current.uid, gid: current.gid }
        : posix === undefined
          ? { uid: 0, gid: 0 }
          : this.creationOwner(parent ?? this.requireDirectory(dirname(plan.path)), posix);
    const mode = this.inlineWriteMode(plan, current, parent, posix);
    const previousInlineBytes = current?.contentClass === "inline" ? current.sizeBytes : 0;
    const inlineDelta = sizeBytes - previousInlineBytes;
    const entryDelta = current === null ? 1 : 0;
    if (pending === undefined) this.assertCapacity(inlineDelta, entryDelta, plan.path);
    else {
      pending.inlineBytes += inlineDelta;
      pending.entries += entryDelta;
    }
    const mutationVersion =
      current === null ? this.nextEntryVersion(plan.path) : current.mutationVersion + 1;
    return { owner, mode, inlineDelta, entryDelta, mutationVersion };
  }

  private inlineWriteMode(
    plan: InlineWritePlan,
    current: EntryRow | null,
    parent: EntryRow | undefined,
    posix: PosixAccessContext | undefined,
  ): number {
    if (current !== null) return posix === undefined ? (plan.mode ?? current.mode) : current.mode;
    if (posix === undefined) return plan.mode ?? FILE_MODE;
    return this.creationMode(
      plan.mode ?? FILE_MODE,
      posix,
      parent ?? this.requireDirectory(dirname(plan.path)),
      false,
    );
  }

  private writeInlineEntry(
    plan: InlineWritePlan,
    current: EntryRow | null,
    mutation: InlineMutationPlan,
    sizeBytes: number,
    digest: string | undefined,
    now: number,
  ): SqlRow | undefined {
    if (current?.contentClass === "inline") {
      return firstRow(
        this.sql.exec<SqlRow>(
          `UPDATE vfs_entries SET
             size_bytes = ?, mode = ?, modified_at_ms = ?, revision = revision + 1,
             body_digest = ?, body_digest_revision = revision + 1, mutation_version = ?
           WHERE id = ? AND mutation_version = ?
           RETURNING id, revision`,
          sizeBytes,
          mutation.mode,
          now,
          digest ?? null,
          mutation.mutationVersion,
          current.id,
          plan.conditionalMutationVersion ?? current.mutationVersion,
        ),
      );
    }
    return this.sql
      .exec<SqlRow>(
        `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           body_digest, body_digest_revision, mutation_version
         ) VALUES (?, ?, ?, ?, 'file', 'inline', NULL, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'inline', opaque_object_id = NULL,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms,
           revision = vfs_entries.revision + 1,
           body_digest = excluded.body_digest,
           body_digest_revision = vfs_entries.revision + 1,
           mutation_version = excluded.mutation_version
         RETURNING id, revision`,
        current?.id ?? this.allocateIno(),
        plan.path,
        dirname(plan.path),
        basename(plan.path),
        sizeBytes,
        mutation.mode,
        mutation.owner.uid,
        mutation.owner.gid,
        current?.createdAtMs ?? now,
        now,
        digest ?? null,
        mutation.mutationVersion,
      )
      .one();
  }

  private finishInlineWrite(
    plan: InlineWritePlan,
    current: EntryRow | null,
    mutation: InlineMutationPlan,
    written: SqlRow,
    chunks: readonly Uint8Array[],
    sizeBytes: number,
    now: number,
  ): InlineWriteOutcome {
    const token = this.publishToken(
      plan.path,
      mutation.mutationVersion,
      true,
      current === null ? "create" : "write",
    );
    this.writeChunks(
      integerColumn(written, "id"),
      0,
      chunks,
      current?.contentClass === "inline" &&
        current.sizeBytes > 0 &&
        current.sizeBytes <= this.chunkBytes,
    );
    this.updateUsage(mutation.inlineDelta, mutation.entryDelta);
    const queuedGarbage =
      current?.contentClass === "opaque" &&
      current.opaqueObjectId !== null &&
      this.queueObjectIfUnreferenced(current.opaqueObjectId, now);
    return {
      result: {
        path: plan.path,
        revision: integerColumn(written, "revision"),
        mutationToken: token,
        sizeBytes,
        created: current === null,
      },
      queuedGarbage,
    };
  }

  /** Publishes a collected set with one transaction and one aggregate quota decision. */
  protected commitInlineWriteSet(
    collected: readonly CollectedWrite[],
    posix: PosixAccessContext | undefined,
  ): { results: WriteResult[]; queuedGarbage: boolean } {
    let queuedGarbage = false;
    const results = this.useBufferedSet(collected, () =>
      this.transaction(() => {
        const before = this.usage();
        // Headroom is a property of the database rather than of the set, so it
        // is weighed before the batch writes anything as well as after. The
        // quotas can only be weighed after, because what the set costs is not
        // known until every entry has decided whether it is writing at all.
        this.assertCapacityFrom(before, 0, 0);
        const now = this.now();
        const pending = { inlineBytes: 0, entries: 0 };
        const written: WriteResult[] = [];
        for (const item of collected) {
          const outcome = this.commitInlineWrite(
            item.plan,
            item.lease.chunks,
            item.lease.sizeBytes,
            item.digest,
            now,
            posix,
            pending,
          );
          if (outcome.queuedGarbage) queuedGarbage = true;
          written.push(outcome.result);
        }
        this.assertCapacityFrom(before, pending.inlineBytes, pending.entries);
        return written;
      }),
    );
    return { results, queuedGarbage };
  }
}
