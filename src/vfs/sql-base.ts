import { VfsError } from "../core/errors.js";
import { descendantRange, dirname } from "../core/path.js";
import { InFlightByteBudget } from "./buffering.js";
import { resolveFileSystemLimits, validatePositiveInteger } from "./config.js";
import { emitVfsEvent, type VfsEventSink } from "./events.js";
import { migrateSql } from "./sql-migrate.js";
import {
  type EntryRow,
  firstRow,
  type InlineEntryRow,
  integerColumn,
  type PendingMutation,
  type SqlFileSystemOptions,
  type SqlFileSystemStorage,
  type SqlRow,
  stringColumn,
  type VfsSqlBinding,
  type VfsSqlStorage,
} from "./sql-model.js";
import {
  EXECUTE_PERMISSION,
  type PosixAccessContext,
  posixPermissions,
  SETGID_BIT,
  STICKY_BIT,
} from "./sql-posix.js";
import type { OpaqueStore } from "./types.js";

const DEFAULT_MAX_DATABASE_BYTES = 10_000_000_000;
const DEFAULT_DATABASE_HEADROOM_BYTES = 64 * 1024 * 1024;

export abstract class SqlBase {
  protected readonly storage: SqlFileSystemStorage;
  protected readonly sql: VfsSqlStorage;
  protected readonly chunkBytes: number;
  protected readonly maxInlineFileBytes: number;
  protected readonly maxInlineLogicalBytes: () => number;
  protected readonly maxEntries: () => number;
  protected readonly inFlightBytes: InFlightByteBudget;
  protected readonly maxDatabaseBytes: number;
  protected readonly minDatabaseHeadroomBytes: number;
  protected readonly uploadSettlementGraceMs: number;
  protected readonly receiptRetentionMs: number;
  protected readonly opaqueStore: OpaqueStore | undefined;
  protected readonly clock: () => number;
  protected readonly createId: () => string;
  protected readonly workspaceId: string;
  protected readonly onEvent: VfsEventSink | undefined;
  protected readonly mutationEpoch: string;
  /** Non-zero while a transaction body is on the stack. */
  protected transactionDepth = 0;
  /**
   * `vfs_usage` as the running transaction has it.
   *
   * The row is a singleton that only this transaction can be changing, and a
   * transaction body never yields, so reading it once and applying each delta
   * in memory answers exactly what re-reading would — for the capacity checks
   * a single write makes twice, and for the total an observer is handed.
   */
  protected transactionUsage: { inlineBytes: number; entries: number } | undefined;
  /** Set inside a transaction, reported once the commit is durable. */
  protected pendingUsage: { inlineBytes: number; entries: number } | undefined;
  /**
   * Namespace changes this transaction has made, held until it commits.
   *
   * Only ever appended to when a sink is attached, so an unobserved workspace
   * allocates nothing rather than building events it will discard.
   */
  protected pendingMutations: PendingMutation[] = [];
  /**
   * How many links exist, so a namespace without any pays nothing for them.
   *
   * Resolution consults this before doing any extra work: at zero it is exactly
   * the single indexed lookup the filesystem made before links existed, which
   * is what keeps the common case from slowing down. The Durable Object owns
   * its database outright and runs single-threaded, so a cached count cannot go
   * stale behind another writer.
   */
  protected symlinkCount: number;
  /**
   * Set when a delete or a copy may have changed the link count.
   *
   * The count is only ever consulted to answer "are there any links?", so
   * over-counting merely does correct work that turns out to be unnecessary,
   * while under-counting to zero would skip resolution entirely. Recomputing on
   * demand keeps that impossible, and a namespace with no links never reaches
   * the recompute at all.
   */
  protected symlinkCountStale = false;
  protected readonly recordChanges: boolean;
  /**
   * The last sequence handed out, read from SQLite once and then kept here.
   *
   * The Durable Object owns its database outright and runs single-threaded, so
   * an in-memory counter cannot race another writer, and reading the maximum
   * again on the next start is what makes it monotonic across eviction. Keeping
   * it here rather than in a row is what makes the feature cost no statement
   * per mutation: a counter row would be a second write on every change.
   *
   * A rolled-back transaction leaves its number unused. A gap is harmless
   * because a caller only ever compares against a sequence it was given.
   */
  protected lastChangeSeq: number | undefined;
  /** The next entry identity, read once per instance from `vfs_usage`. */
  protected nextIno: number;
  /** Metadata from the last direct inline read; never file-body bytes. */
  protected lastInlineRead: InlineEntryRow | undefined;
  /** Stored layout from the last ranged body; keyed by immutable identity and revision. */
  protected lastInlineChunkLayout:
    | { readonly id: number; readonly revision: number; readonly chunkBytes: number }
    | undefined;

  constructor(storage: SqlFileSystemStorage, options: SqlFileSystemOptions = {}) {
    const limits = resolveFileSystemLimits(options);
    this.storage = storage;
    this.sql = storage.sql;
    this.chunkBytes = limits.chunkBytes;
    this.maxInlineFileBytes = limits.maxInlineFileBytes;
    this.maxInlineLogicalBytes = limits.maxInlineLogicalBytes;
    this.maxEntries = limits.maxEntries;
    this.onEvent = options.onEvent;
    this.inFlightBytes = new InFlightByteBudget(limits.maxInFlightBufferedBytes, options.onEvent);
    this.maxDatabaseBytes = options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES;
    this.minDatabaseHeadroomBytes =
      options.minDatabaseHeadroomBytes ?? DEFAULT_DATABASE_HEADROOM_BYTES;
    this.uploadSettlementGraceMs = limits.uploadSettlementGraceMs;
    this.receiptRetentionMs = limits.receiptRetentionMs;
    this.opaqueStore = options.opaqueStore;
    this.clock = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.workspaceId = options.workspaceId ?? "workspace";
    this.recordChanges = options.recordChanges ?? false;

    for (const [name, value] of [
      ["maxDatabaseBytes", this.maxDatabaseBytes],
      ["minDatabaseHeadroomBytes", this.minDatabaseHeadroomBytes],
    ] as const)
      validatePositiveInteger(value, name);
    this.mutationEpoch = migrateSql({
      sql: this.sql,
      transaction: (callback) => this.transaction(callback),
      execBatch: (query) => this.execBatch(query),
      now: () => this.now(),
      newToken: () => this.newToken(),
    });
    this.symlinkCount = this.countSymlinks();
    // Read once per instance, beside the link count and for the same reason:
    // paying it here keeps it off every operation that allocates an identity.
    this.nextIno = integerColumn(
      this.sql.exec<SqlRow>("SELECT next_ino FROM vfs_usage WHERE singleton = 1").one(),
      "next_ino",
    );
  }

  protected countSymlinks(): number {
    return integerColumn(
      this.sql
        .exec<SqlRow>("SELECT COUNT(*) AS links FROM vfs_entries WHERE kind = 'symlink'")
        .one(),
      "links",
    );
  }

  /** How many links exist, recomputed only when a mutation may have changed it. */
  protected links(): number {
    if (this.symlinkCountStale) {
      this.symlinkCount = this.countSymlinks();
      this.symlinkCountStale = false;
    }
    return this.symlinkCount;
  }

  protected now(): number {
    return this.clock();
  }

  protected assertPermission(
    entry: Pick<EntryRow, "uid" | "gid" | "mode" | "kind" | "path">,
    access: PosixAccessContext | undefined,
    required: number,
    path = entry.path,
  ): void {
    if (access === undefined || required === 0) return;
    if (
      access.credentials.uid === 0 &&
      !(required === EXECUTE_PERMISSION && entry.kind === "file" && (entry.mode & 0o111) === 0)
    )
      return;
    if ((posixPermissions(entry, access) & required) !== required) {
      throw new VfsError("EACCES", "permission denied", path);
    }
  }

  protected assertOwner(
    entry: Pick<EntryRow, "uid" | "path">,
    access: PosixAccessContext | undefined,
    path = entry.path,
  ): void {
    if (
      access !== undefined &&
      access.credentials.uid !== 0 &&
      access.credentials.uid !== entry.uid
    ) {
      throw new VfsError("EPERM", "operation requires the file owner", path);
    }
  }

  protected assertStickyRemoval(
    parent: EntryRow,
    target: EntryRow,
    access: PosixAccessContext | undefined,
    path = target.path,
  ): void {
    if (
      access === undefined ||
      access.credentials.uid === 0 ||
      (parent.mode & STICKY_BIT) === 0 ||
      access.credentials.uid === parent.uid ||
      access.credentials.uid === target.uid
    )
      return;
    throw new VfsError("EPERM", "sticky directory denies removing this entry", path);
  }

  /**
   * Checks execute permission on every directory used to reach a canonical
   * path, plus the written-side ancestors of each followed link.
   *
   * All ancestors are fetched by one indexed `IN` query. Depth therefore adds
   * rows, not statements, and the no-credentials path never calls this helper.
   */
  protected assertTraverse(
    path: string,
    followed: readonly string[],
    access: PosixAccessContext | undefined,
  ): void {
    if (access === undefined) return;
    const ancestors = new Set<string>();
    for (const candidate of [path, ...followed]) {
      for (let parent = dirname(candidate); ; parent = dirname(parent)) {
        ancestors.add(parent);
        if (parent === "/") break;
      }
    }
    if (path === "/") ancestors.delete("/");
    if (ancestors.size === 0) return;
    const ordered = [...ancestors];
    const rows = this.sql
      .exec<SqlRow>(
        `SELECT path, kind, mode, uid, gid
         FROM vfs_entries INDEXED BY vfs_entries_path
         WHERE path IN (SELECT value FROM json_each(?))`,
        JSON.stringify(ordered),
      )
      .toArray();
    if (rows.length !== ordered.length) {
      throw new VfsError("ENOENT", "an ancestor directory does not exist", path);
    }
    for (const row of rows) {
      const kind = stringColumn(row, "kind");
      const parent = stringColumn(row, "path");
      if (kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent);
      this.assertPermission(
        {
          path: parent,
          kind: "directory",
          mode: integerColumn(row, "mode"),
          uid: integerColumn(row, "uid"),
          gid: integerColumn(row, "gid"),
        },
        access,
        EXECUTE_PERMISSION,
        path,
      );
    }
  }

  protected creationMode(
    mode: number,
    access: PosixAccessContext | undefined,
    parent: EntryRow,
    directory: boolean,
    intermediate = false,
  ): number {
    if (access === undefined) return mode;
    let permissions = mode & 0o7777 & ~access.umask;
    // Recursive creation must leave each intermediate directory searchable
    // and writable by its creator long enough to create the next component.
    // This is the POSIX `mkdir -p` rule and matters for restrictive umasks.
    if (directory && intermediate) permissions |= 0o300;
    if (directory && (parent.mode & SETGID_BIT) !== 0) permissions |= SETGID_BIT;
    const type = directory ? 0o040000 : 0o100000;
    return type | permissions;
  }

  protected creationOwner(
    parent: EntryRow,
    access: PosixAccessContext | undefined,
  ): { uid: number; gid: number } {
    if (access === undefined) return { uid: 0, gid: 0 };
    return {
      uid: access.credentials.uid,
      gid: (parent.mode & SETGID_BIT) !== 0 ? parent.gid : access.credentials.gid,
    };
  }

  protected permissionExpression(
    alias: string,
    access: PosixAccessContext,
  ): { sql: string; bindings: VfsSqlBinding[] } {
    const groups = [...access.groups];
    return {
      sql: `CASE
        WHEN ${alias}.uid = ? THEN ((${alias}.mode >> 6) & 7)
        WHEN ${alias}.gid IN (SELECT value FROM json_each(?))
          THEN ((${alias}.mode >> 3) & 7)
        ELSE (${alias}.mode & 7)
      END`,
      bindings: [access.credentials.uid, JSON.stringify(groups)],
    };
  }

  /**
   * Conservative recursive semantics: a set operation is atomic, so an
   * inaccessible descendant rejects the whole operation instead of exposing
   * or mutating a partial prefix. SQLite performs the preflight in one range
   * scan and returns at most the first denied path.
   */
  protected assertSubtreePermissions(
    path: string,
    access: PosixAccessContext | undefined,
    filePermissions: number,
    directoryPermissions: number,
  ): void {
    if (access === undefined || access.credentials.uid === 0) return;
    const range = descendantRange(path);
    const expression = this.permissionExpression("e", access);
    const denied = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT e.path
         FROM vfs_entries e INDEXED BY vfs_entries_path
         WHERE (e.path = ? OR (e.path >= ? AND e.path < ?))
           AND (
             (e.kind = 'directory' AND ((${expression.sql}) & ?) <> ?)
             OR
             (e.kind = 'file' AND ((${expression.sql}) & ?) <> ?)
           )
         ORDER BY e.path
         LIMIT 1`,
        path,
        range.lower,
        range.upper,
        ...expression.bindings,
        directoryPermissions,
        directoryPermissions,
        ...expression.bindings,
        filePermissions,
        filePermissions,
      ),
    );
    if (denied !== undefined) {
      throw new VfsError("EACCES", "permission denied", stringColumn(denied, "path"));
    }
  }

  protected assertSubtreeSticky(path: string, access: PosixAccessContext | undefined): void {
    if (access === undefined || access.credentials.uid === 0) return;
    const range = descendantRange(path);
    const denied = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT child.path
         FROM vfs_entries child INDEXED BY vfs_entries_path
         JOIN vfs_entries parent INDEXED BY vfs_entries_path
           ON parent.path = child.parent_path
         WHERE (child.path > ? AND child.path >= ? AND child.path < ?)
           AND (parent.mode & ?) <> 0
           AND ? <> parent.uid
           AND ? <> child.uid
         ORDER BY child.path
         LIMIT 1`,
        path,
        range.lower,
        range.upper,
        STICKY_BIT,
        access.credentials.uid,
        access.credentials.uid,
      ),
    );
    if (denied !== undefined) {
      throw new VfsError(
        "EPERM",
        "sticky directory denies removing this entry",
        stringColumn(denied, "path"),
      );
    }
  }

  protected newToken(): string {
    return this.createId();
  }

  protected transaction<T>(callback: () => T): T {
    try {
      const result = this.storage.transactionSync(() => {
        this.transactionDepth += 1;
        try {
          return callback();
        } finally {
          this.transactionDepth -= 1;
          // A rollback discards the in-memory total along with the row it
          // mirrored, so the next reader goes back to SQLite either way.
          if (this.transactionDepth === 0) this.transactionUsage = undefined;
        }
      });
      // Report only after the commit succeeded, and never from inside the
      // transaction, where a throwing observer would roll the mutation back.
      // A nested call returns before anything is committed, so the drain waits
      // for the outermost one: `transactionSync` runs the callback directly
      // when a transaction is already open, and reporting there would announce
      // work an outer rollback is still free to discard.
      if (this.transactionDepth === 0) {
        const usage = this.pendingUsage;
        if (usage !== undefined) {
          this.pendingUsage = undefined;
          emitVfsEvent(this.onEvent, { type: "vfs.usage", ...usage });
        }
        if (this.pendingMutations.length > 0) {
          const mutations = this.pendingMutations;
          this.pendingMutations = [];
          for (const mutation of mutations) {
            emitVfsEvent(this.onEvent, { type: "vfs.mutation", ...mutation });
          }
        }
      }
      return result;
    } catch (error) {
      this.pendingUsage = undefined;
      this.pendingMutations = [];
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (/SQLITE_FULL|database or disk is full/iu.test(message)) {
        throw new VfsError("ENOSPC", "SQLite database capacity is exhausted");
      }
      throw error;
    }
  }

  protected execBatch(query: string): void {
    if (this.storage.execBatch === undefined) this.sql.exec(query);
    else this.storage.execBatch(query);
  }
}
