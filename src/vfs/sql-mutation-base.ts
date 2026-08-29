import { VfsError } from "../core/errors.js";
import { descendantRange } from "../core/path.js";
import { emitVfsEvent, type VfsQuotaLimit } from "./events.js";
import { integerColumn, type SqlRow } from "./sql-model.js";
import { SqlPath } from "./sql-path-base.js";
import type { SubtreeSummary } from "./types.js";

export abstract class SqlMutation extends SqlPath {
  protected usage(): { inlineBytes: number; entries: number } {
    if (this.transactionUsage !== undefined) return this.transactionUsage;
    const row = this.sql
      .exec<SqlRow>("SELECT inline_bytes, entries FROM vfs_usage WHERE singleton = 1")
      .one();
    const usage = {
      inlineBytes: integerColumn(row, "inline_bytes"),
      entries: integerColumn(row, "entries"),
    };
    if (this.transactionDepth > 0) this.transactionUsage = usage;
    return usage;
  }

  /**
   * The next entry identity to hand out, and the one after it.
   *
   * Held in memory and made durable by riding the usage UPDATE that every
   * entry creation already performs, which is what makes never reusing an
   * identity cost nothing: no counter row of its own, no `sqlite_sequence`,
   * no extra statement. Seeded once per instance, and monotone across
   * eviction because the durable value is written with the entry that used it.
   *
   * A rolled-back transaction leaves its numbers unused. A gap is harmless —
   * nothing derives meaning from an identity being consecutive.
   */
  protected allocateIno(count = 1): number {
    const first = this.nextIno;
    this.nextIno += count;
    return first;
  }

  protected updateUsage(inlineDelta: number, entryDelta: number): void {
    if (inlineDelta === 0 && entryDelta === 0) {
      if (this.onEvent !== undefined) this.pendingUsage = this.transactionUsage ?? this.usage();
      return;
    }
    // `next_ino` rides this statement rather than one of its own: the row is
    // already being written, so persisting the high-water mark is free.
    this.sql.exec(
      `UPDATE vfs_usage SET
         inline_bytes = inline_bytes + ?, entries = entries + ?,
         next_ino = MAX(next_ino, ?)
       WHERE singleton = 1`,
      inlineDelta,
      entryDelta,
      this.nextIno,
    );
    const cached = this.transactionUsage;
    if (cached !== undefined) {
      this.transactionUsage = {
        inlineBytes: cached.inlineBytes + inlineDelta,
        entries: cached.entries + entryDelta,
      };
    }
    if (this.onEvent !== undefined) this.pendingUsage = this.usage();
  }

  /** Reports the storage limit that refused work, then fails. */
  protected quotaExceeded(
    limit: VfsQuotaLimit,
    requested: number,
    used: number,
    max: number,
    message: string,
    path?: string,
  ): never {
    emitVfsEvent(this.onEvent, {
      type: "vfs.quota",
      limit,
      requested,
      used,
      max,
      ...(path === undefined ? {} : { path }),
    });
    throw new VfsError("ENOSPC", message, path);
  }

  /**
   * Refuses work that would carry the workspace past a quota.
   *
   * Only growth is refused. Comparing the end state alone would also refuse a
   * mutation that holds steady or gives space back, which is wrong once usage
   * exceeds a limit: writing less is the way out of that state. The two agree
   * everywhere below a ceiling and at it, so this changes only what happens
   * above one -- which a limit that can move is what makes reachable.
   */
  protected assertCapacity(inlineDelta: number, entryDelta: number, path?: string): void {
    if (inlineDelta <= 0 && entryDelta <= 0) {
      this.maxInlineLogicalBytes();
      this.maxEntries();
      if (this.onEvent !== undefined) this.usage();
      this.assertDatabaseHeadroom(path);
      return;
    }
    this.assertCapacityFrom(this.usage(), inlineDelta, entryDelta, path);
  }

  protected assertDatabaseHeadroom(path?: string): void {
    const databaseSize = this.sql.databaseSize;
    if (databaseSize + this.minDatabaseHeadroomBytes > this.maxDatabaseBytes) {
      this.quotaExceeded(
        "databaseHeadroom",
        this.minDatabaseHeadroomBytes,
        databaseSize,
        this.maxDatabaseBytes,
        "SQLite database headroom is exhausted",
        path,
      );
    }
  }

  /**
   * The same refusal, weighed against a stated starting point.
   *
   * A batch accumulates its entries' deltas and weighs them once against the
   * usage it began from, which `usage()` cannot report by then because every
   * entry has already moved it. Passing the base in is what lets one set be
   * judged as one thing, and that is the whole difference between refusing a
   * set that ends over a ceiling and refusing an entry that is momentarily
   * over one inside a set that ends under it.
   */
  protected assertCapacityFrom(
    usage: { inlineBytes: number; entries: number },
    inlineDelta: number,
    entryDelta: number,
    path?: string,
  ): void {
    const maxInlineLogicalBytes = this.maxInlineLogicalBytes();
    if (inlineDelta > 0 && usage.inlineBytes + inlineDelta > maxInlineLogicalBytes) {
      this.quotaExceeded(
        "maxInlineLogicalBytes",
        inlineDelta,
        usage.inlineBytes,
        maxInlineLogicalBytes,
        "workspace inline-byte quota exceeded",
        path,
      );
    }
    const maxEntries = this.maxEntries();
    if (entryDelta > 0 && usage.entries + entryDelta > maxEntries) {
      this.quotaExceeded(
        "maxEntries",
        entryDelta,
        usage.entries,
        maxEntries,
        "filesystem entry quota exceeded",
        path,
      );
    }
    this.assertDatabaseHeadroom(path);
  }

  protected aggregateSubtree(path: string): SubtreeSummary {
    const range = descendantRange(path);
    const row = this.sql
      .exec<SqlRow>(
        `SELECT COUNT(*) AS entries,
              COALESCE(SUM(CASE WHEN content_class = 'inline' THEN size_bytes ELSE 0 END), 0)
                AS inline_bytes,
              COALESCE(SUM(CASE WHEN kind = 'file' THEN size_bytes ELSE 0 END), 0)
                AS logical_file_bytes
       FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)`,
        path,
        range.lower,
        range.upper,
      )
      .one();
    return {
      entries: integerColumn(row, "entries"),
      inlineBytes: integerColumn(row, "inline_bytes"),
      logicalFileBytes: integerColumn(row, "logical_file_bytes"),
    };
  }

  protected publishSubtreeRemoval(path: string, changeSeq = this.nextChangeSeq()): void {
    const range = descendantRange(path);
    this.sql.exec(
      `INSERT INTO vfs_path_tombstones (path, version)
       SELECT path, mutation_version + 1 FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)
       ON CONFLICT(path) DO UPDATE SET
         version = MAX(vfs_path_tombstones.version, excluded.version)`,
      path,
      range.lower,
      range.upper,
    );
    if (!this.recordChanges) return;
    this.sql.exec(
      `INSERT INTO vfs_path_changes (path, change_seq, present)
       SELECT path, ?, 0 FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)
       ON CONFLICT(path) DO UPDATE SET
         change_seq = excluded.change_seq,
         present = 0`,
      changeSeq,
      path,
      range.lower,
      range.upper,
    );
  }

  protected recordPresentSubtree(path: string, changeSeq: number): void {
    if (!this.recordChanges) return;
    const range = descendantRange(path);
    this.sql.exec(
      `INSERT INTO vfs_path_changes (path, change_seq, present)
       SELECT path, ?, 1 FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)
       ON CONFLICT(path) DO UPDATE SET
         change_seq = excluded.change_seq,
         present = 1`,
      changeSeq,
      path,
      range.lower,
      range.upper,
    );
  }

  protected clearSubtreeTombstones(path: string): void {
    const range = descendantRange(path);
    this.sql.exec(
      `DELETE FROM vfs_path_tombstones
       WHERE (path = ? OR (path >= ? AND path < ?))
         AND EXISTS (
           SELECT 1 FROM vfs_entries WHERE vfs_entries.path = vfs_path_tombstones.path
         )`,
      path,
      range.lower,
      range.upper,
    );
  }
}
