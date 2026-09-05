import { VfsError } from "../core/errors.js";
import { normalizePath, pathRequiresDirectory } from "../core/path.js";
import { emitVfsEvent } from "./events.js";
import {
  blobColumn,
  type CollectedWrite,
  firstRow,
  type InlineEntryRow,
  type InlineWritePlan,
  integerColumn,
  type SqlRow,
} from "./sql-model.js";
import { type PosixAccessContext, WRITE_PERMISSION } from "./sql-posix.js";
import { SqlWritePlan } from "./sql-write-plan-base.js";
import { rechunk } from "./streams.js";
import type {
  AppendFileOptions,
  ByteBody,
  WriteFileOptions,
  WriteFilesEntry,
  WriteFilesOptions,
  WriteResult,
} from "./types.js";

export abstract class SqlWrite extends SqlWritePlan {
  /** Uses the same write planner as publication without changing storage. Returns the effective mode. */
  validateInlineWrite(
    path: string,
    options: WriteFileOptions = {},
    sizeBytes?: number,
    additionalInlineBytes = 0,
    posix?: PosixAccessContext,
  ): number {
    const plan = this.planInlineWrite(path, options, options, posix);
    const before = plan.capturedEntry;
    if (before?.contentClass !== "inline")
      throw new VfsError("ENOTSUP", "deferred writes require an existing inline file", path);
    if (sizeBytes !== undefined) {
      if (
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 0 ||
        !Number.isSafeInteger(additionalInlineBytes) ||
        additionalInlineBytes < 0
      )
        throw new VfsError("EINVAL", "invalid deferred write size", path);
      this.assertAppendSize(before, path, sizeBytes);
      this.assertCapacity(sizeBytes - before.sizeBytes + additionalInlineBytes, 0, path);
    }
    return posix === undefined ? (options.mode ?? before.mode) : before.mode;
  }

  async writeFile(
    path: string,
    body: ByteBody,
    options: WriteFileOptions = {},
    posix?: PosixAccessContext,
  ): Promise<WriteResult> {
    const materialized = options.skipIfUnchanged !== true && typeof body === "string";
    const snapshot =
      materialized &&
      posix === undefined &&
      options.disposition !== "create" &&
      !pathRequiresDirectory(path) &&
      options.ifMutationToken !== undefined &&
      options.ifMutationToken === this.lastInlineRead?.mutationToken &&
      normalizePath(path) === this.lastInlineRead.path
        ? this.lastInlineRead
        : undefined;
    const plan = this.planInlineWrite(path, options, options, posix, snapshot);
    const buffered = materialized ? this.collectInlineSync(body) : await this.collectInline(body);
    const digest = materialized ? undefined : await this.incomingDigest(options, buffered);
    let queued = false;
    const result = this.useBuffered(buffered, (chunks, sizeBytes) =>
      this.transaction(() => {
        const outcome = this.commitInlineWrite(
          plan,
          chunks,
          sizeBytes,
          digest,
          this.now(),
          posix,
          false,
          !materialized,
        );
        queued = outcome.queuedGarbage;
        return outcome.result;
      }),
    );
    if (queued) await this.scheduleGarbageAlarm();
    return result;
  }

  /**
   * Writes several bodies to several paths as one change.
   *
   * The three phases are the whole design, and the order is what makes it
   * possible at all. Every entry is planned against SQLite synchronously, so
   * a batch that cannot succeed is refused before it holds a byte. Then every
   * body is collected; this awaits only if the set contains a stream or asks
   * for a digest. Then one transaction publishes the set, holding no cursor
   * across anything.
   *
   * An open transaction handed back to the host would be the other way to
   * offer this, and it is the reason this shape exists instead: it would hold
   * the storage lock across arbitrary caller code. What survives that
   * constraint is collect, then commit.
   */
  async writeFiles(
    entries: readonly WriteFilesEntry[],
    options: WriteFilesOptions = {},
    posix?: PosixAccessContext,
  ): Promise<WriteResult[]> {
    if (entries.length === 0) return [];
    const plans: InlineWritePlan[] = [];
    const claimed = new Set<string>();
    for (const entry of entries) {
      const plan = this.planInlineWrite(entry.path, entry, options, posix);
      // Compared after resolution, so two spellings of one file are caught as
      // well as two copies of one spelling -- `a` beside `./a`, and a link
      // beside what it points at. Neither last-write-wins nor a merge is
      // something a caller can have meant.
      if (claimed.has(plan.path)) {
        throw new VfsError("EINVAL", "the batch names this path more than once", plan.path);
      }
      claimed.add(plan.path);
      plans.push(plan);
    }
    // Every body is held at once, charged to the instance-wide in-flight
    // budget one at a time. A set too large for that budget is refused by the
    // limit that already bounds how much a caller can materialize rather than
    // by a second one -- and the leases taken before the refusal are released
    // here rather than waiting for a transaction that will never open.
    const collected: CollectedWrite[] = [];
    let held = 0;
    try {
      for (const [index, entry] of entries.entries()) {
        const plan = plans[index];
        if (plan === undefined) break;
        // What the batch is already holding, so the budget can tell a set too
        // large for it -- retrying which is work with no outcome -- from one
        // that merely collided with a concurrent read or batch.
        const lease = await this.collectInline(entry.body, held);
        held += lease.sizeBytes;
        collected.push({
          plan,
          lease,
          digest: await this.incomingDigest(options, lease),
        });
      }
    } catch (error) {
      for (const item of collected) item.lease.release();
      throw error;
    }
    const committed = this.commitInlineWriteSet(collected, posix);
    if (committed.queuedGarbage) await this.scheduleGarbageAlarm();
    return committed.results;
  }

  async appendFile(
    path: string,
    body: ByteBody,
    options: AppendFileOptions = {},
    posix?: PosixAccessContext,
  ): Promise<WriteResult> {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const before = this.requireInline(normalized, access.row);
    this.assertPermission(before, posix, WRITE_PERMISSION, normalized);
    this.validateGuard(normalized, before, options, path);
    const capturedToken = before.mutationToken;
    const materialized = typeof body === "string";
    const buffered = materialized ? this.collectInlineSync(body) : await this.collectInline(body);
    return this.useBuffered(buffered, (chunks, bytes) =>
      this.commitAppend(
        normalized,
        path,
        access.followed,
        capturedToken,
        chunks,
        bytes,
        options,
        posix,
        materialized ? before : undefined,
      ),
    );
  }

  private commitAppend(
    path: string,
    writtenPath: string,
    followed: readonly string[],
    capturedToken: string,
    suffixChunks: readonly Uint8Array[],
    suffixBytes: number,
    options: AppendFileOptions,
    posix: PosixAccessContext | undefined,
    snapshot?: InlineEntryRow,
  ): WriteResult {
    return this.transaction(() => {
      const current =
        snapshot === undefined || suffixBytes === 0 ? this.requireInline(path) : snapshot;
      if (current.mutationToken !== capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", path);
      }
      this.validateGuard(path, current, options, writtenPath);
      this.assertTraverse(path, followed, posix);
      this.assertPermission(current, posix, WRITE_PERMISSION, path);
      if (suffixBytes === 0) {
        return {
          path,
          revision: current.revision,
          mutationToken: capturedToken,
          sizeBytes: current.sizeBytes,
          created: false,
        };
      }
      return this.appendContent(current, path, suffixChunks, suffixBytes, snapshot !== undefined);
    });
  }

  private appendContent(
    current: InlineEntryRow,
    path: string,
    suffixChunks: readonly Uint8Array[],
    suffixBytes: number,
    conditional: boolean,
  ): WriteResult {
    const sizeBytes = current.sizeBytes + suffixBytes;
    this.assertAppendSize(current, path, sizeBytes);
    this.assertCapacity(suffixBytes, 0, path);
    const plan = this.appendChunkPlan(current, path, suffixChunks);
    const now = this.now();
    const mutationVersion = current.mutationVersion + 1;
    const written = this.sql.exec<SqlRow>(
      `UPDATE vfs_entries SET size_bytes = ?, modified_at_ms = ?, revision = revision + 1,
         mutation_version = ? WHERE id = ? ${conditional ? "AND mutation_version = ? RETURNING id" : ""}`,
      sizeBytes,
      now,
      mutationVersion,
      current.id,
      ...(conditional ? [current.mutationVersion] : []),
    );
    if (conditional && firstRow(written) === undefined)
      throw new VfsError("EREVISION", "path changed before append", path);
    this.writeChunks(current.id, plan.firstChunkIndex, plan.chunks);
    const token = this.publishToken(path, mutationVersion, true, "write");
    this.updateUsage(suffixBytes, 0);
    return {
      path,
      revision: current.revision + 1,
      mutationToken: token,
      sizeBytes,
      created: false,
    };
  }

  private assertAppendSize(current: InlineEntryRow, path: string, sizeBytes: number): void {
    if (sizeBytes <= this.maxInlineFileBytes) return;
    emitVfsEvent(this.onEvent, {
      type: "vfs.quota",
      limit: "maxInlineFileBytes",
      requested: sizeBytes,
      used: current.sizeBytes,
      max: this.maxInlineFileBytes,
      path,
    });
    throw new VfsError(
      "EFBIG",
      `inline content exceeds the ${this.maxInlineFileBytes}-byte limit`,
      path,
    );
  }

  private appendChunkPlan(
    current: InlineEntryRow,
    path: string,
    suffixChunks: readonly Uint8Array[],
  ): { firstChunkIndex: number; chunks: readonly Uint8Array[] } {
    const lastChunk = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT chunk_index, body FROM vfs_inline_chunks
         WHERE entry_id = ? ORDER BY chunk_index DESC LIMIT 1`,
        current.id,
      ),
    );
    if (lastChunk === undefined) {
      if (current.sizeBytes !== 0) {
        throw new VfsError("EIO", "inline file is missing stored chunks", path);
      }
      return { firstChunkIndex: 0, chunks: suffixChunks };
    }
    const index = integerColumn(lastChunk, "chunk_index");
    const tail = new Uint8Array(blobColumn(lastChunk, "body"));
    const expectedIndex = Math.floor((current.sizeBytes - 1) / this.chunkBytes);
    const expectedBytes = current.sizeBytes - expectedIndex * this.chunkBytes;
    if (current.sizeBytes === 0 || index !== expectedIndex || tail.byteLength !== expectedBytes) {
      throw new VfsError("EIO", "inline file chunks do not match its size", path);
    }
    return tail.byteLength === this.chunkBytes
      ? { firstChunkIndex: index + 1, chunks: suffixChunks }
      : {
          firstChunkIndex: index,
          chunks: rechunk([tail, ...suffixChunks], this.chunkBytes),
        };
  }
}
