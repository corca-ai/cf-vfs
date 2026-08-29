import { VfsError } from "../core/errors.js";
import { sha256Hex } from "./digest.js";
import { byteRangeBounds } from "./range.js";
import {
  blobColumn,
  type EntryRow,
  firstRow,
  type InlineEntryRow,
  integerColumn,
  nullableIntegerColumn,
  nullableStringColumn,
  parseEntry,
  rowToStat,
  type SqlRow,
} from "./sql-model.js";
import { type PosixAccessContext, READ_PERMISSION } from "./sql-posix.js";
import { SqlQuery } from "./sql-query-base.js";
import { ENTRY_COLUMNS } from "./sql-schema.js";
import { streamFromOwnedChunks } from "./streams.js";
import type { InlineReadResult, ReadFileOptions } from "./types.js";

const MIN_INLINE_SQL_RANGE_BYTES = 16 * 1024;

function sliceChunkSequence<Buffer extends ArrayBufferLike>(
  chunks: readonly Uint8Array<Buffer>[],
  offset: number,
  length: number,
): Uint8Array<Buffer>[] {
  const selected: Uint8Array<Buffer>[] = [];
  let skip = offset;
  let remaining = length;
  for (const chunk of chunks) {
    if (skip >= chunk.byteLength) {
      skip -= chunk.byteLength;
      continue;
    }
    const take = Math.min(remaining, chunk.byteLength - skip);
    selected.push(chunk.subarray(skip, skip + take));
    remaining -= take;
    skip = 0;
    if (remaining === 0) break;
  }
  return selected;
}

export abstract class SqlRead extends SqlQuery {
  async digestFile(path: string, posix?: PosixAccessContext): Promise<string> {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);

    const { entry, cachedDigest } = this.digestEntry(access.row, normalized);

    if (entry.kind === "directory") {
      throw new VfsError("EISDIR", "is a directory", normalized);
    }
    this.assertPermission(entry, posix, READ_PERMISSION, normalized);
    if (entry.contentClass === "opaque") return this.opaqueDigest(entry, normalized);
    if (entry.contentClass !== "inline") {
      throw new VfsError("EIO", "invalid SQLite entry state", normalized);
    }
    if (cachedDigest !== null) return cachedDigest;

    return await this.computeInlineDigest(entry, normalized);
  }

  private digestEntry(
    resolved: EntryRow | null,
    path: string,
  ): { entry: EntryRow; cachedDigest: string | null } {
    if (resolved !== null) {
      const cachedDigest =
        resolved.contentClass === "inline" ? this.storedDigest(resolved.id) : null;
      return { entry: resolved, cachedDigest };
    }
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS}, e.body_digest AS body_digest,
                e.body_digest_revision AS body_digest_revision
         FROM vfs_entries e WHERE e.path = ?`,
        path,
      ),
    );
    if (row === undefined) throw new VfsError("ENOENT", "no such file or directory", path);
    const entry = parseEntry(row, this.mutationEpoch);
    const digestRevision = nullableIntegerColumn(row, "body_digest_revision");
    const cachedDigest =
      digestRevision === entry.revision ? nullableStringColumn(row, "body_digest") : null;
    return { entry, cachedDigest };
  }

  private opaqueDigest(entry: Extract<EntryRow, { contentClass: "opaque" }>, path: string): string {
    const object = this.opaqueObject(entry.opaqueObjectId);
    if (object === null) throw new VfsError("EIO", "opaque object metadata is missing", path);
    if (object.verifiedSha256 === null) {
      throw new VfsError("ENOTSUP", "opaque digest is not verified", path);
    }
    return object.verifiedSha256;
  }

  private async computeInlineDigest(entry: InlineEntryRow, path: string): Promise<string> {
    const rows = this.sql
      .exec<SqlRow>(
        `SELECT body FROM vfs_inline_chunks
         WHERE entry_id = ? ORDER BY chunk_index`,
        entry.id,
      )
      .toArray();
    const chunks = rows.map((row) => new Uint8Array(blobColumn(row, "body")));
    const materializedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (materializedBytes !== entry.sizeBytes) {
      throw new VfsError("EIO", "inline file size does not match stored chunks", path);
    }
    this.inFlightBytes.acquire(materializedBytes);
    let digest: string;
    try {
      digest = await sha256Hex(chunks, materializedBytes);
    } finally {
      this.inFlightBytes.release(materializedBytes);
    }
    // Hashing yields to the event loop. Cache only if the same entry revision
    // is still current; the returned digest remains the snapshot read above.
    this.sql.exec(
      `UPDATE vfs_entries
       SET body_digest = ?, body_digest_revision = revision
       WHERE id = ? AND revision = ? AND content_class = 'inline'`,
      digest,
      entry.id,
      entry.revision,
    );
    return digest;
  }

  readFile(
    path: string,
    options: ReadFileOptions = {},
    posix?: PosixAccessContext,
  ): InlineReadResult {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const entry = access.row ?? this.requireEntry(normalized);
    if (entry.kind === "directory") {
      throw new VfsError("EISDIR", "is a directory", normalized);
    }
    this.assertPermission(entry, posix, READ_PERMISSION, normalized);
    if (entry.contentClass !== "inline") {
      throw new VfsError(
        "ENOTSUP",
        "opaque R2 content is not available to shell commands",
        normalized,
      );
    }
    const selected = byteRangeBounds(options.range, entry.sizeBytes, normalized);
    const readWholeBody =
      options.range === undefined ||
      (selected.offset === 0 && selected.length === entry.sizeBytes) ||
      (entry.sizeBytes <= MIN_INLINE_SQL_RANGE_BYTES && entry.sizeBytes <= this.chunkBytes);
    const rows = this.readInlineRows(entry, selected, readWholeBody, normalized);
    const materialized = rows.map((row) => new Uint8Array(blobColumn(row, "body")));
    const chunks =
      readWholeBody && options.range !== undefined && selected.length < entry.sizeBytes
        ? sliceChunkSequence(materialized, selected.offset, selected.length)
        : materialized;
    const materializedBytes = materialized.reduce((total, chunk) => total + chunk.byteLength, 0);
    this.inFlightBytes.acquire(materializedBytes);
    if (access.followed.length === 0) this.lastInlineRead = entry;
    return {
      stat: rowToStat(entry),
      stream: streamFromOwnedChunks(chunks, () => {
        this.inFlightBytes.release(materializedBytes);
      }),
    };
  }

  private readInlineRows(
    entry: InlineEntryRow,
    selected: { offset: number; length: number },
    readWholeBody: boolean,
    path: string,
  ): SqlRow[] {
    if (selected.length === 0) return [];
    if (readWholeBody) {
      return this.sql
        .exec<SqlRow>(
          `SELECT body FROM vfs_inline_chunks
           WHERE entry_id = ? ORDER BY chunk_index`,
          entry.id,
        )
        .toArray();
    }
    const storedChunkBytes = this.storedChunkBytes(entry, path);
    return this.sql
      .exec<SqlRow>(
        `SELECT substr(
             body,
             max(0, ? - chunk_index * ?) + 1,
             min(length(body), ? - chunk_index * ?) -
               max(0, ? - chunk_index * ?)
           ) AS body
           FROM vfs_inline_chunks
           WHERE entry_id = ? AND chunk_index BETWEEN ? AND ?
           ORDER BY chunk_index`,
        selected.offset,
        storedChunkBytes,
        selected.offset + selected.length,
        storedChunkBytes,
        selected.offset,
        storedChunkBytes,
        entry.id,
        Math.floor(selected.offset / storedChunkBytes),
        Math.floor((selected.offset + selected.length - 1) / storedChunkBytes),
      )
      .toArray();
  }

  private storedChunkBytes(entry: InlineEntryRow, path: string): number {
    const cached = this.lastInlineChunkLayout;
    const chunkBytes =
      cached !== undefined && cached.id === entry.id && cached.revision === entry.revision
        ? cached.chunkBytes
        : integerColumn(
            this.sql
              .exec<SqlRow>(
                `SELECT length(body) AS chunk_bytes
                 FROM vfs_inline_chunks
                 WHERE entry_id = ? ORDER BY chunk_index LIMIT 1`,
                entry.id,
              )
              .one(),
            "chunk_bytes",
          );
    if (chunkBytes === 0) {
      throw new VfsError("EIO", "inline file contains an empty stored chunk", path);
    }
    this.lastInlineChunkLayout = { id: entry.id, revision: entry.revision, chunkBytes };
    return chunkBytes;
  }
}
