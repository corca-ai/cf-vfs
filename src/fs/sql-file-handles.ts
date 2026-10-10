import { VfsError } from "../core/errors.js";
import { isDescendant } from "../core/path.js";
import type { HandleProvider, SqlHandlePort } from "../vfs/handle-port.js";
import {
  blobColumn,
  type EntryRow,
  firstRow,
  integerColumn,
  parseEntry,
  type SqlRow,
  stringColumn,
} from "../vfs/sql-model.js";
import type { PosixAccessContext } from "../vfs/sql-posix.js";
import { ENTRY_COLUMNS } from "../vfs/sql-schema.js";
import { FsFileHandle } from "./file-handle.js";
import { position } from "./handle-utils.js";
import { installHardLinkTriggers } from "./hard-links.js";
import { leasedStream } from "./leased-stream.js";
import { materialize } from "./read.js";
import { FsStats } from "./stats.js";

function detachedRow(json: string): SqlRow {
  const value: unknown = JSON.parse(json);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new VfsError("EIO", "invalid detached inode");
  const row: Record<string, SqlStorageValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== null && typeof field !== "number" && typeof field !== "string")
      throw new VfsError("EIO", "invalid inode column");
    row[key] = field;
  }
  return row;
}

/** One manager per SQL owner; all credential views share its inode pins. */
export class SqlFileHandles implements HandleProvider {
  private readonly pins = new Map<number, number>();
  private nextDescriptor = 3;
  constructor(private readonly port: SqlHandlePort) {
    port.retain((path, recursive, root) => this.retain(path, recursive, root));
  }
  link(from: string, to: string, access?: PosixAccessContext): void {
    installHardLinkTriggers(this.port);
    this.port.transaction(() => {
      const source = this.port.sourceEntry(from, access);
      if (source.kind === "directory")
        throw new VfsError("EPERM", "directories cannot be hard linked", from);
      const destination = this.port.openEntry(to, false, false, true, true, 0o666, access);
      const identity = source.linkIdentity ?? source.id;
      const count = (source.linkCount ?? 1) + 1;
      this.port.capacity(source.contentClass === "inline" ? source.sizeBytes : 0, to);
      this.port.sql.exec(
        "UPDATE vfs_entries SET link_identity = ?, link_count = ? WHERE id = ?",
        identity,
        count,
        source.id,
      );
      this.port.sql.exec(
        `UPDATE vfs_entries SET kind = ?, content_class = ?, opaque_object_id = ?, link_target = ?,
        size_bytes = ?, mode = ?, uid = ?, gid = ?, created_at_ms = ?, modified_at_ms = ?, changed_at_ms = ?,
        link_identity = ?, link_count = ?, revision = ?, mutation_version = ? WHERE id = ?`,
        source.kind,
        source.contentClass,
        source.opaqueObjectId,
        source.linkTarget,
        source.sizeBytes,
        source.mode,
        source.uid,
        source.gid,
        source.createdAtMs,
        source.modifiedAtMs,
        this.port.now(),
        identity,
        count,
        Math.max(source.revision, destination.revision) + 1,
        Math.max(source.mutationVersion, destination.mutationVersion) + 1,
        destination.id,
      );
      if (source.contentClass === "inline")
        this.port.sql.exec(
          "INSERT INTO vfs_inline_chunks SELECT ?, chunk_index, body FROM vfs_inline_chunks WHERE entry_id = ?",
          destination.id,
          source.id,
        );
      this.port.usage(source.contentClass === "inline" ? source.sizeBytes : 0);
      this.port.linked();
      this.port.publish(this.entry(identity));
    });
  }
  open(path: string, flags: string, mode: number, access?: PosixAccessContext): FsFileHandle {
    if (!/^(r|r\+|w|w\+|wx|wx\+|a|a\+|ax|ax\+)$/.test(flags))
      throw new VfsError("EINVAL", "unsupported open flags", path);
    if (this.count() >= 1024) throw new VfsError("EMFILE", "too many open handles");
    const readable = flags.startsWith("r") || flags.endsWith("+");
    const writable = !flags.startsWith("r") || flags.endsWith("+");
    const entry = this.port.openEntry(
      path,
      readable,
      writable,
      !flags.startsWith("r"),
      flags.includes("x"),
      mode,
      access,
    );
    const identity = entry.linkIdentity ?? entry.id;
    this.pins.set(identity, (this.pins.get(identity) ?? 0) + 1);
    try {
      if (flags.startsWith("w")) this.truncate(identity, 0);
      return new FsFileHandle(
        this,
        identity,
        this.nextDescriptor++,
        readable,
        writable,
        flags.startsWith("a"),
      );
    } catch (error) {
      this.release(identity);
      throw error;
    }
  }
  private count(): number {
    let count = 0;
    for (const value of this.pins.values()) count += value;
    return count;
  }
  private retained(ino: number): SqlRow | undefined {
    return firstRow(
      this.port.sql.exec<SqlRow>("SELECT entry_json FROM vfs_detached_inodes WHERE id = ?", ino),
    );
  }
  entry(ino: number): EntryRow {
    const row = firstRow(
      this.port.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS} FROM vfs_entries e WHERE id = (
           SELECT id FROM vfs_entries WHERE id = ?
           UNION SELECT id FROM vfs_entries WHERE link_identity = ?
           ORDER BY id LIMIT 1
         )`,
        ino,
        ino,
      ),
    );
    if (row !== undefined) return parseEntry(row, this.epoch(row));
    const detached = this.retained(ino);
    if (detached === undefined) throw new VfsError("EBADF", "inode is no longer open");
    const columns = detachedRow(stringColumn(detached, "entry_json"));
    return parseEntry(columns, this.epoch(columns));
  }
  // The epoch is immutable and read only on first handle use, not ordinary paths.
  private mutationEpoch: string | undefined;
  private epoch(_row: SqlRow): string {
    this.mutationEpoch ??= stringColumn(
      this.port.sql.exec<SqlRow>("SELECT mutation_epoch FROM vfs_state WHERE singleton = 1").one(),
      "mutation_epoch",
    );
    return this.mutationEpoch;
  }
  private retain(path: string, recursive: boolean, root: EntryRow): number {
    let retained = 0;
    for (const ino of this.retainedCandidates(root, recursive)) {
      const row = firstRow(
        this.port.sql.exec<SqlRow>(
          `SELECT ${ENTRY_COLUMNS} FROM vfs_entries e WHERE id = (
           SELECT id FROM vfs_entries WHERE id = ?
           UNION SELECT id FROM vfs_entries WHERE link_identity = ?
           ORDER BY id LIMIT 1
         )`,
          ino,
          ino,
        ),
      );
      if (row === undefined) continue;
      const entry = parseEntry(row, this.epoch(row));
      if (entry.path !== path && !(recursive && isDescendant(path, entry.path))) continue;
      if (this.hasRemainingName(entry, path, recursive)) continue;
      const inlineBytes = entry.contentClass === "inline" ? entry.sizeBytes : 0;
      this.port.sql.exec(
        "INSERT INTO vfs_detached_inodes(id, entry_json, inline_bytes, opaque_object_id) VALUES (?, ?, ?, ?)",
        ino,
        JSON.stringify({ ...row, id: ino, link_count: 0, changed_at_ms: this.port.now() }),
        inlineBytes,
        entry.opaqueObjectId,
      );
      if (entry.contentClass === "inline")
        this.port.sql.exec(
          "INSERT INTO vfs_detached_chunks SELECT ?, chunk_index, body FROM vfs_inline_chunks WHERE entry_id = ?",
          ino,
          entry.id,
        );
      retained += inlineBytes;
    }
    return retained;
  }
  private retainedCandidates(root: EntryRow, recursive: boolean): Iterable<number> {
    if (recursive) return this.pins.keys();
    const identity = root.linkIdentity ?? root.id;
    return this.pins.has(identity) ? [identity] : [];
  }
  private hasRemainingName(entry: EntryRow, path: string, recursive: boolean): boolean {
    if (entry.linkIdentity == null) return false;
    return this.port.sql
      .exec<SqlRow>("SELECT path FROM vfs_entries WHERE link_identity = ?", entry.linkIdentity)
      .toArray()
      .some((item) => {
        const name = stringColumn(item, "path");
        return name !== path && !(recursive && isDescendant(path, name));
      });
  }
  release(ino: number): void {
    const count = this.pins.get(ino);
    if (count === undefined) return;
    if (count > 1) {
      this.pins.set(ino, count - 1);
      return;
    }
    this.port.transaction(() => {
      const detached = firstRow(
        this.port.sql.exec<SqlRow>(
          "SELECT inline_bytes, opaque_object_id FROM vfs_detached_inodes WHERE id = ?",
          ino,
        ),
      );
      if (detached === undefined) return;
      this.port.sql.exec("DELETE FROM vfs_detached_chunks WHERE entry_id = ?", ino);
      this.port.sql.exec("DELETE FROM vfs_detached_inodes WHERE id = ?", ino);
      this.port.usage(-integerColumn(detached, "inline_bytes"));
      if (typeof detached["opaque_object_id"] === "number")
        this.port.reclaimObject(detached["opaque_object_id"]);
    });
    this.pins.delete(ino);
  }
  sync(): Promise<void> {
    return this.port.sync();
  }
  maintenance(): Promise<void> {
    return this.port.maintenance();
  }
  stat(ino: number): FsStats {
    const entry = this.entry(ino);
    return new FsStats(this.port.stat(entry), entry.linkCount ?? 1);
  }
  async read(ino: number, offset: number, length: number): Promise<Uint8Array> {
    return this.readEntry(this.entry(ino), offset, length);
  }
  readRemaining(ino: number, offset: number): Promise<Uint8Array> {
    const entry = this.entry(ino);
    return this.readEntry(entry, offset, Math.max(0, entry.sizeBytes - offset));
  }
  private async readEntry(entry: EntryRow, offset: number, length: number): Promise<Uint8Array> {
    const selected = Math.min(length, Math.max(0, entry.sizeBytes - offset));
    if (selected === 0) return new Uint8Array();
    if (entry.contentClass === "opaque") return this.readOpaque(entry, offset, selected);
    const table = entry.linkCount !== 0 ? "vfs_inline_chunks" : "vfs_detached_chunks";
    const first = this.port.sql
      .exec<SqlRow>(
        `SELECT length(body) AS size FROM ${table} WHERE entry_id = ? AND chunk_index = 0`,
        entry.id,
      )
      .one();
    const width = integerColumn(first, "size");
    if (width <= 0) throw new VfsError("EIO", "invalid inode chunk width");
    const begin = Math.floor(offset / width);
    const end = Math.ceil((offset + selected) / width);
    const reserved = Math.min(entry.sizeBytes, (end - begin) * width) + selected;
    this.port.budget.acquire(reserved);
    try {
      const rows = this.port.sql
        .exec<SqlRow>(
          `SELECT chunk_index, body FROM ${table} WHERE entry_id = ? AND chunk_index >= ? AND chunk_index < ? ORDER BY chunk_index`,
          entry.id,
          begin,
          end,
        )
        .toArray();
      const output = new Uint8Array(selected);
      let consumed = 0;
      for (const row of rows) {
        const base = integerColumn(row, "chunk_index") * width;
        const body = new Uint8Array(blobColumn(row, "body"));
        const from = Math.max(0, offset - base);
        const to = Math.min(body.byteLength, offset + selected - base);
        if (to > from) {
          output.set(body.subarray(from, to), base + from - offset);
          consumed += to - from;
        }
      }
      if (consumed !== selected) throw new VfsError("EIO", "inode body does not match range");
      return output;
    } finally {
      this.port.budget.release(reserved);
    }
  }
  private async readOpaque(entry: EntryRow, offset: number, length: number): Promise<Uint8Array> {
    const store = this.port.store;
    if (store === undefined || entry.opaqueObjectId === null)
      throw new VfsError("ENOTSUP", "opaque handle requires a store");
    const expires = this.port.now() + 60_000;
    const object = this.port.sql
      .exec<SqlRow>(
        "UPDATE vfs_opaque_objects SET retain_until_ms = MAX(retain_until_ms, ?) WHERE id = ? RETURNING r2_key",
        expires,
        entry.opaqueObjectId,
      )
      .one();
    const stream = await store.getStream(stringColumn(object, "r2_key"), { offset, length });
    if (stream === null) throw new VfsError("EIO", "opaque body is missing");
    if (this.port.now() >= expires) {
      await stream.cancel();
      throw new VfsError("EIO", "opaque read lease expired", entry.path);
    }
    const stat = this.port.stat(entry);
    if (stat.kind !== "file" || stat.contentClass !== "opaque")
      throw new VfsError("EIO", "invalid open inode");
    return materialize(
      {
        stat: { ...stat, sizeBytes: length },
        stream: leasedStream(stream, entry.path, expires, length, () => this.port.now()),
      },
      this.port.maximum,
      this.port.budget,
    );
  }
  write(ino: number, body: Uint8Array, offset: number | null, append: boolean): number {
    return this.port.transaction(() => {
      const entry = this.entry(ino);
      if (entry.contentClass !== "inline")
        throw new VfsError("ENOTSUP", "random opaque writes require a content tier");
      const start = append ? entry.sizeBytes : position(offset ?? 0);
      if (body.byteLength === 0) return start;
      const size = Math.max(entry.sizeBytes, start + body.byteLength);
      this.validateSize(size, entry.path);
      this.port.capacity((size - entry.sizeBytes) * Math.max(1, entry.linkCount ?? 1), entry.path);
      const detached = entry.linkCount === 0;
      const table = detached ? "vfs_detached_chunks" : "vfs_inline_chunks";
      this.writeChunks(entry, body, start, size, table);
      this.update(entry, size, detached);
      return start + body.byteLength;
    });
  }
  private writeChunks(
    entry: EntryRow,
    body: Uint8Array,
    start: number,
    size: number,
    table: string,
  ): void {
    const first = firstRow(
      this.port.sql.exec<SqlRow>(
        `SELECT length(body) AS size FROM ${table} WHERE entry_id = ? AND chunk_index = 0`,
        entry.id,
      ),
    );
    const firstSize = first === undefined ? 0 : integerColumn(first, "size");
    const chunkBytes =
      firstSize < entry.sizeBytes ? firstSize : Math.max(firstSize, this.port.chunkBytes);
    const begin = Math.floor(Math.min(start, entry.sizeBytes) / chunkBytes);
    const end = Math.ceil((start + body.byteLength) / chunkBytes);
    for (let index = begin; index < end; index++) {
      const base = index * chunkBytes;
      const chunk = new Uint8Array(Math.min(chunkBytes, size - base));
      // Only surviving old bytes need a read; new/hole and fully replaced chunks do not.
      const oldEnd = Math.min(base + chunk.byteLength, entry.sizeBytes);
      if (base < oldEnd && (start > base || start + body.byteLength < oldEnd)) {
        const old = firstRow(
          this.port.sql.exec<SqlRow>(
            `SELECT body FROM ${table} WHERE entry_id = ? AND chunk_index = ?`,
            entry.id,
            index,
          ),
        );
        if (old !== undefined)
          chunk.set(new Uint8Array(blobColumn(old, "body")).subarray(0, chunk.byteLength));
      }
      const from = Math.max(start, base);
      const to = Math.min(start + body.byteLength, base + chunk.byteLength);
      if (to > from) chunk.set(body.subarray(from - start, to - start), from - base);
      this.port.sql.exec(
        `INSERT INTO ${table}(entry_id, chunk_index, body) VALUES (?, ?, ?) ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body`,
        entry.id,
        index,
        chunk,
      );
    }
  }
  truncate(ino: number, size: number): void {
    this.validateSize(size, "");
    const entry = this.entry(ino);
    if (entry.contentClass !== "inline")
      throw new VfsError("ENOTSUP", "opaque truncate requires a content tier");
    if (size > entry.sizeBytes) {
      this.write(ino, new Uint8Array(size - entry.sizeBytes), entry.sizeBytes, false);
      return;
    }
    this.port.transaction(() => {
      const current = this.entry(ino);
      const detached = entry.linkCount === 0;
      const table = detached ? "vfs_detached_chunks" : "vfs_inline_chunks";
      if (size === 0) this.port.sql.exec(`DELETE FROM ${table} WHERE entry_id = ?`, current.id);
      else {
        const first = this.port.sql
          .exec<SqlRow>(
            `SELECT length(body) AS size FROM ${table} WHERE entry_id = ? AND chunk_index = 0`,
            current.id,
          )
          .one();
        const width = integerColumn(first, "size");
        if (width <= 0) throw new VfsError("EIO", "invalid inode chunk width");
        const end = Math.ceil(size / width);
        this.port.sql.exec(
          `DELETE FROM ${table} WHERE entry_id = ? AND chunk_index >= ?`,
          current.id,
          end,
        );
        const tail = size % width;
        if (tail !== 0)
          this.port.sql.exec(
            `UPDATE ${table} SET body = substr(body, 1, ?) WHERE entry_id = ? AND chunk_index = ?`,
            tail,
            current.id,
            end - 1,
          );
      }
      this.update(current, size, detached);
    });
  }
  private validateSize(size: number, path: string): void {
    position(size);
    if (size > this.port.maximum)
      throw new VfsError("EFBIG", "inode exceeds inline file limit", path);
  }
  private update(entry: EntryRow, size: number, detached: boolean): void {
    const now = this.port.now();
    if (detached)
      this.port.sql.exec(
        `UPDATE vfs_detached_inodes SET inline_bytes = ?, entry_json = json_set(entry_json,
      '$.size_bytes', ?, '$.modified_at_ms', ?, '$.changed_at_ms', ?, '$.revision', ?, '$.mutation_version', ?) WHERE id = ?`,
        size,
        size,
        now,
        now,
        entry.revision + 1,
        entry.mutationVersion + 1,
        entry.id,
      );
    else {
      this.port.sql.exec(
        "UPDATE vfs_entries SET size_bytes = ?, modified_at_ms = ?, changed_at_ms = ?, body_digest = NULL, body_digest_revision = NULL, revision = revision + 1, mutation_version = mutation_version + 1 WHERE id = ?",
        size,
        now,
        now,
        entry.id,
      );
      this.port.publish({
        ...entry,
        sizeBytes: size,
        modifiedAtMs: now,
        changedAtMs: now,
        revision: entry.revision + 1,
        mutationVersion: entry.mutationVersion + 1,
      });
    }
    this.port.usage((size - entry.sizeBytes) * Math.max(1, entry.linkCount ?? 1));
  }
}
