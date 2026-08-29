import { isVfsError, VfsError } from "../core/errors.js";
import { basename, dirname } from "../core/path.js";
import { collectInlineBytes, collectInlineBytesSync } from "./buffering.js";
import { DIRECTORY_MODE } from "./config.js";
import { sha256Hex } from "./digest.js";
import { emitVfsEvent } from "./events.js";
import {
  blobColumn,
  type CollectedWrite,
  type CreationParents,
  type EntryRow,
  firstRow,
  integerColumn,
  type SqlRow,
  stringColumn,
} from "./sql-model.js";
import { SqlMutation } from "./sql-mutation-base.js";
import { EXECUTE_PERMISSION, type PosixAccessContext, WRITE_PERMISSION } from "./sql-posix.js";
import type { ByteBody } from "./types.js";

function equalSpan(
  left: Uint8Array,
  leftOffset: number,
  right: Uint8Array,
  rightOffset: number,
  length: number,
): boolean {
  for (let index = 0; index < length; index += 1) {
    if (left[leftOffset + index] !== right[rightOffset + index]) return false;
  }
  return true;
}

class StoredBodyCursor {
  private index = -1;
  private position = 0;
  private body = new Uint8Array(0);

  constructor(private readonly rows: readonly SqlRow[]) {}

  matches(chunks: readonly Uint8Array[]): boolean {
    for (const chunk of chunks) if (!this.matchesChunk(chunk)) return false;
    return true;
  }

  private matchesChunk(chunk: Uint8Array): boolean {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (!this.advanceBody()) return false;
      const span = Math.min(this.body.byteLength - this.position, chunk.byteLength - offset);
      if (!equalSpan(this.body, this.position, chunk, offset, span)) return false;
      this.position += span;
      offset += span;
    }
    return true;
  }

  private advanceBody(): boolean {
    while (this.position >= this.body.byteLength) {
      this.index += 1;
      const row = this.rows[this.index];
      if (row === undefined) return false;
      this.body = new Uint8Array(blobColumn(row, "body"));
      this.position = 0;
    }
    return true;
  }
}

export abstract class SqlContent extends SqlMutation {
  protected createDirectory(
    path: string,
    now: number,
    mode = DIRECTORY_MODE,
    access?: PosixAccessContext,
    intermediate = false,
    knownParent?: EntryRow,
  ): EntryRow {
    const parent =
      access === undefined ? undefined : (knownParent ?? this.requireDirectory(dirname(path)));
    if (parent !== undefined) {
      this.assertPermission(parent, access, WRITE_PERMISSION | EXECUTE_PERMISSION, path);
    }
    const effectiveMode =
      parent === undefined ? mode : this.creationMode(mode, access, parent, true, intermediate);
    const owner = parent === undefined ? { uid: 0, gid: 0 } : this.creationOwner(parent, access);
    const mutationVersion = this.nextEntryVersion(path);
    const inserted = this.sql
      .exec<SqlRow>(
        `INSERT INTO vfs_entries (
         id, path, parent_path, name, kind, content_class, opaque_object_id,
         size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
         mutation_version
       ) VALUES (?, ?, ?, ?, 'directory', NULL, NULL, 0, ?, ?, ?, ?, ?, 1, ?)
       RETURNING id`,
        this.allocateIno(),
        path,
        dirname(path),
        basename(path),
        effectiveMode,
        owner.uid,
        owner.gid,
        now,
        now,
        mutationVersion,
      )
      .one();
    const token = this.publishToken(path, mutationVersion, true, "create");
    const id = integerColumn(inserted, "id");
    this.updateUsage(0, 1);
    return {
      id,
      path,
      parentPath: dirname(path),
      name: basename(path),
      kind: "directory",
      contentClass: null,
      opaqueObjectId: null,
      linkTarget: null,
      sizeBytes: 0,
      mode: effectiveMode,
      uid: owner.uid,
      gid: owner.gid,
      createdAtMs: now,
      modifiedAtMs: now,
      revision: 1,
      mutationVersion,
      mutationToken: token,
    };
  }

  protected creationParents(path: string, recursive: boolean): CreationParents {
    const missing: string[] = [];
    let current = dirname(path);
    // The walk resolves each candidate; keeping the row it stopped on spares
    // `requireDirectory` from resolving that same path a second time.
    let parent = this.oneResolved(current);
    while (parent === null) {
      missing.unshift(current);
      current = dirname(current);
      parent = this.oneResolved(current);
    }
    // A link is not a parent, even one that resolves to a directory. The child
    // is stored naming what stands here, and a link can be repointed or removed
    // while the child stays — which is how a row ends up under something that
    // is not a directory. Every caller canonicalizes before it gets here, so a
    // link at this point means an ancestor changed since, and that is exactly
    // what has to be refused. Resolution trusting an exact hit rests on this.
    if (parent !== null && parent.path !== current) {
      throw new VfsError("ENOTDIR", "not a directory", current);
    }
    const existingParent = this.requireDirectory(current, parent);
    if (missing.length > 0 && !recursive) {
      throw new VfsError("ENOENT", "parent directory does not exist", dirname(path));
    }
    return { existing: existingParent, missing };
  }

  protected assertCreationAccess(
    path: string,
    followed: readonly string[],
    access: PosixAccessContext | undefined,
    parent: EntryRow,
  ): void {
    if (access === undefined) return;
    this.assertTraverse(parent.path, followed, access);
    this.assertPermission(parent, access, WRITE_PERMISSION | EXECUTE_PERMISSION, path);
  }

  protected prepareParents(
    path: string,
    recursive: boolean,
    now: number,
    followed: readonly string[],
    access?: PosixAccessContext,
  ): EntryRow {
    const parents = this.creationParents(path, recursive);
    this.assertCreationAccess(path, followed, access, parents.existing);
    return this.createMissingParents(path, now, access, parents);
  }

  protected createMissingParents(
    path: string,
    now: number,
    access: PosixAccessContext | undefined,
    parents: CreationParents,
  ): EntryRow {
    // Every caller weighs the entry it is about to create after this returns.
    // With no intermediate directory there is nothing to reserve here, so a
    // second capacity/headroom check would only repeat that caller's work.
    if (parents.missing.length === 0) return parents.existing;
    this.assertCapacity(0, parents.missing.length, path);
    let parent = parents.existing;
    for (const missingParent of parents.missing) {
      parent = this.createDirectory(missingParent, now, DIRECTORY_MODE, access, true, parent);
    }
    return parent;
  }

  protected assertWriteAccess(
    path: string,
    entry: EntryRow | null,
    recursive: boolean,
    followed: readonly string[],
    access: PosixAccessContext | undefined,
  ): void {
    if (entry === null) {
      if (access === undefined) return;
      const parents = this.creationParents(path, recursive);
      this.assertCreationAccess(path, followed, access, parents.existing);
      return;
    }
    this.assertTraverse(path, followed, access);
    this.assertPermission(entry, access, WRITE_PERMISSION, path);
  }

  protected assertDestinationReplaceable(
    destination: EntryRow | null,
    target: string,
    replace: boolean,
  ): void {
    if (destination === null) return;
    if (!replace) throw new VfsError("EEXIST", "destination exists", target);
    if (destination.kind !== "directory") return;
    const child = firstRow(
      this.sql.exec<SqlRow>(
        "SELECT 1 AS present FROM vfs_entries WHERE parent_path = ? LIMIT 1",
        target,
      ),
    );
    if (child !== undefined) throw new VfsError("ENOTEMPTY", "directory is not empty", target);
  }

  protected async collectInline(body: ByteBody, heldByCaller = 0) {
    try {
      return await collectInlineBytes(
        body,
        this.maxInlineFileBytes,
        this.chunkBytes,
        this.inFlightBytes,
        heldByCaller,
      );
    } catch (error) {
      this.throwInlineCollectionError(error);
    }
  }

  protected collectInlineSync(body: string) {
    try {
      return collectInlineBytesSync(
        body,
        this.maxInlineFileBytes,
        this.chunkBytes,
        this.inFlightBytes,
      );
    } catch (error) {
      this.throwInlineCollectionError(error);
    }
  }

  protected throwInlineCollectionError(error: unknown): never {
    // Collection aborts at the ceiling, so the body's real size is unknown.
    if (isVfsError(error) && error.code === "EFBIG") {
      emitVfsEvent(this.onEvent, {
        type: "vfs.quota",
        limit: "maxInlineFileBytes",
        used: this.maxInlineFileBytes,
        max: this.maxInlineFileBytes,
      });
    }
    throw error;
  }

  protected useBuffered<T>(
    buffered: { chunks: Uint8Array[]; sizeBytes: number; release(): void },
    operation: (chunks: Uint8Array[], sizeBytes: number) => T,
  ): T {
    try {
      return operation(buffered.chunks, buffered.sizeBytes);
    } finally {
      buffered.release();
    }
  }

  /**
   * The same release guarantee for a set of bodies held at once.
   *
   * A batch cannot release as it goes: nothing is published until the last
   * entry has been committed, so every body has to stay materialized until the
   * transaction closes, and every lease has to be given back whether it
   * committed or threw.
   */
  protected useBufferedSet<T>(collected: readonly CollectedWrite[], operation: () => T): T {
    try {
      return operation();
    } finally {
      for (const item of collected) item.lease.release();
    }
  }

  /**
   * The digest of a body about to be written, or undefined when none is wanted.
   *
   * Taken whenever the caller asked to skip an unchanged body, over slabs the
   * call is already holding and before the transaction opens, because
   * `crypto.subtle` is asynchronous and no cursor may cross an await.
   *
   * Deliberately not narrowed to the case that can skip. A digest is only ever
   * recorded by a call that computes one, so hashing only when the sizes
   * already match would leave a workspace that never publishes a differing
   * body -- the steady state of a debounced flush -- without one forever.
   */
  protected async incomingDigest(
    options: { skipIfUnchanged?: boolean },
    buffered: { chunks: readonly Uint8Array[]; sizeBytes: number },
  ): Promise<string | undefined> {
    if (options.skipIfUnchanged !== true) return undefined;
    return sha256Hex(buffered.chunks, buffered.sizeBytes);
  }

  /**
   * The digest recorded for an entry, or null when there is none to trust.
   *
   * The stamp is compared in SQL rather than read back and checked here, so a
   * stale one returns no row and the caller falls through to reading the body.
   */
  protected storedDigest(entryId: number): string | null {
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT body_digest FROM vfs_entries
       WHERE id = ? AND body_digest IS NOT NULL AND body_digest_revision = revision`,
        entryId,
      ),
    );
    return row === undefined ? null : stringColumn(row, "body_digest");
  }

  /**
   * Whether the stored body is what is about to be written.
   *
   * A recorded digest answers it without reading the body at all. Without one
   * -- a first write, an entry from before the column existed, a stamp left by
   * an earlier revision -- the bodies are compared as before, and a match
   * records the digest so no later call has to read them again.
   *
   * That record is the only write this path performs. It leaves the revision,
   * the token, `modifiedAtMs`, the size, the identity and the usage totals
   * exactly as they were, so nothing a caller can observe about the entry
   * changes; without it a workspace whose body never differs would pay the
   * comparison forever.
   */
  protected bodyIsUnchanged(
    entryId: number,
    revision: number,
    chunks: readonly Uint8Array[],
    digest: string | undefined,
  ): boolean {
    if (digest !== undefined) {
      const stored = this.storedDigest(entryId);
      if (stored !== null) return stored === digest;
    }
    if (!this.inlineBodyMatches(entryId, chunks)) return false;
    if (digest !== undefined) {
      this.sql.exec(
        "UPDATE vfs_entries SET body_digest = ?, body_digest_revision = ? WHERE id = ?",
        digest,
        revision,
        entryId,
      );
    }
    return true;
  }

  /**
   * Whether the stored inline body is byte-identical to the slabs about to
   * replace it.
   *
   * Callers must already have established that the recorded size matches, and
   * that ordering is the whole cost model: a body of a different length is
   * decided from a column already in hand, and only one of the same length
   * pays for this read of its own chunks. A write that is not asking to skip
   * never reaches here at all.
   *
   * Chunk boundaries are not assumed to line up. Both sides are walked as byte
   * sequences instead, so a body stored under a different `chunkBytes` than
   * this instance is configured with still compares correctly rather than
   * reporting a spurious difference.
   */
  protected inlineBodyMatches(entryId: number, chunks: readonly Uint8Array[]): boolean {
    const stored = this.sql
      .exec<SqlRow>(
        `SELECT body FROM vfs_inline_chunks
       WHERE entry_id = ? ORDER BY chunk_index`,
        entryId,
      )
      .toArray();
    return new StoredBodyCursor(stored).matches(chunks);
  }

  /**
   * Uses at most 99 of Cloudflare's 100 bound parameters per statement:
   * three values for each of 33 chunk rows.
   */
  protected writeChunks(
    entryId: number,
    firstIndex: number,
    chunks: readonly Uint8Array[],
    updateSingle = false,
  ): void {
    const single = chunks[0];
    if (updateSingle && chunks.length === 1 && single !== undefined) {
      const updated = firstRow(
        this.sql.exec<SqlRow>(
          `UPDATE vfs_inline_chunks SET body = ?
           WHERE entry_id = ? AND chunk_index = ? RETURNING entry_id`,
          single,
          entryId,
          firstIndex,
        ),
      );
      if (updated === undefined) throw new VfsError("EIO", "inline file is missing a stored chunk");
      return;
    }
    for (let offset = 0; offset < chunks.length; offset += 33) {
      const batch = chunks.slice(offset, offset + 33);
      this.sql.exec(
        `INSERT INTO vfs_inline_chunks(entry_id, chunk_index, body)
         VALUES ${batch.map(() => "(?, ?, ?)").join(", ")}
         ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body`,
        ...batch.flatMap((body, index) => [entryId, firstIndex + offset + index, body]),
      );
    }
  }
}
