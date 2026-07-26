import { isVfsError, VfsError } from "../core/errors.js";
import { globToRegExp } from "../core/glob.js";
import {
  basename,
  depthFrom,
  descendantRange,
  dirname,
  isDescendant,
  normalizePath,
  pathRequiresDirectory,
} from "../core/path.js";
import { collectInlineBytes, InFlightByteBudget } from "./buffering.js";
import {
  type CommonFileSystemOptions,
  DEFAULT_READ_LEASE_MS,
  DEFAULT_UPLOAD_TTL_MS,
  DEFAULT_VERIFY_LEASE_MS,
  DIRECTORY_MODE,
  FILE_MODE,
  MAX_READ_LEASE_MS,
  NEVER_MUTATED_TOKEN,
  resolveFileSystemLimits,
  SYMLINK_MODE,
  validatePositiveInteger,
} from "./config.js";
import { emitVfsEvent, type VfsEventSink, type VfsQuotaLimit } from "./events.js";
import { rechunk, streamFromChunks } from "./streams.js";
import type {
  AppendFileOptions,
  BeginOpaqueUploadOptions,
  ByteBody,
  CommitOpaqueUploadOptions,
  CopyOptions,
  CopyResult,
  EntryKind,
  EntryPage,
  FindOptions,
  GarbageDrainResult,
  InlineFileStat,
  InlineReadResult,
  MetadataUpdateOptions,
  MoveOptions,
  MoveResult,
  MutationTokenOptions,
  OpaqueFileStat,
  OpaqueObjectMetadata,
  OpaqueReadLease,
  OpaqueStore,
  OpaqueUploadReservation,
  OwnershipUpdateOptions,
  PageOptions,
  PosixCredentials,
  PosixViewOptions,
  PosixVirtualFileSystem,
  RemoveOptions,
  RemoveResult,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
  VirtualFileSystem,
  WriteFileOptions,
  WriteResult,
} from "./types.js";
import { MAX_SYMLINK_HOPS, MAX_SYMLINK_TARGET_BYTES } from "./types.js";

const DEFAULT_MAX_DATABASE_BYTES = 10_000_000_000;
const DEFAULT_DATABASE_HEADROOM_BYTES = 64 * 1024 * 1024;
const MAX_GC_BATCH = 100;
const MAX_POSIX_ID = 0xffff_ffff;
const DEFAULT_UMASK = 0o022;
const READ_PERMISSION = 0o4;
const WRITE_PERMISSION = 0o2;
const EXECUTE_PERMISSION = 0o1;
const SETGID_BIT = 0o2000;
const STICKY_BIT = 0o1000;

interface PosixAccessContext {
  readonly credentials: Readonly<Required<PosixCredentials>>;
  readonly groups: ReadonlySet<number>;
  readonly umask: number;
}

type PosixMutationOperation =
  | { readonly kind: "copy"; readonly dereference: boolean }
  | { readonly kind: "move" }
  | { readonly kind: "remove-recursive" };

function posixId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POSIX_ID) {
    throw new VfsError("EINVAL", `${name} must be an integer between 0 and ${MAX_POSIX_ID}`);
  }
  return value;
}

function posixContext(
  credentials: PosixCredentials,
  options: PosixViewOptions = {},
): PosixAccessContext {
  const uid = posixId(credentials.uid, "credentials.uid");
  const gid = posixId(credentials.gid, "credentials.gid");
  const supplementaryGids = [...new Set(credentials.supplementaryGids ?? [])].map((value) =>
    posixId(value, "credentials.supplementaryGids"),
  );
  const umask = options.umask ?? DEFAULT_UMASK;
  if (!Number.isSafeInteger(umask) || umask < 0 || umask > 0o777) {
    throw new VfsError("EINVAL", "umask must be an integer between 000 and 777");
  }
  return Object.freeze({
    credentials: Object.freeze({
      uid,
      gid,
      supplementaryGids: Object.freeze(supplementaryGids),
    }),
    groups: new Set([gid, ...supplementaryGids]),
    umask,
  });
}

function posixPermissions(
  entry: Pick<StatBaseForPermissions, "uid" | "gid" | "mode">,
  access: PosixAccessContext,
): number {
  if (access.credentials.uid === 0) return 0o7;
  if (entry.uid === access.credentials.uid) return (entry.mode >> 6) & 0o7;
  if (access.groups.has(entry.gid)) return (entry.mode >> 3) & 0o7;
  return entry.mode & 0o7;
}

interface StatBaseForPermissions {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

/**
 * The entry table and its indexes.
 *
 * One definition serves both the fresh schema and the rebuild that migrates an
 * existing one, so the two cannot drift: a database created today and a
 * database migrated from version 1 have the same constraints, and the migration
 * test compares them directly.
 *
 * The CHECK is the point. A symlink carries a target and no content, a
 * directory carries neither, and a file carries exactly one content class, so
 * a row that is two of those things at once cannot be written even by code
 * that has forgotten the rule.
 */
const ENTRIES_SCHEMA = `
        CREATE TABLE vfs_entries (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL,
          parent_path TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('directory', 'file', 'symlink')),
          content_class TEXT CHECK (content_class IN ('inline', 'opaque')),
          opaque_object_id INTEGER,
          link_target TEXT,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          mode INTEGER NOT NULL,
          uid INTEGER NOT NULL CHECK (uid >= 0 AND uid <= 4294967295),
          gid INTEGER NOT NULL CHECK (gid >= 0 AND gid <= 4294967295),
          created_at_ms INTEGER NOT NULL,
          modified_at_ms INTEGER NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          CHECK (
            (kind = 'directory' AND content_class IS NULL AND opaque_object_id IS NULL
              AND link_target IS NULL)
            OR (kind = 'file' AND content_class = 'inline' AND opaque_object_id IS NULL
              AND link_target IS NULL)
            OR (kind = 'file' AND content_class = 'opaque' AND opaque_object_id IS NOT NULL
              AND link_target IS NULL)
            OR (kind = 'symlink' AND content_class IS NULL AND opaque_object_id IS NULL
              AND link_target IS NOT NULL AND length(link_target) > 0)
          )
        );
        CREATE UNIQUE INDEX vfs_entries_path
          ON vfs_entries(path);
        CREATE UNIQUE INDEX vfs_entries_parent_name
          ON vfs_entries(parent_path, name);
        CREATE INDEX vfs_entries_opaque_object
          ON vfs_entries(opaque_object_id) WHERE opaque_object_id IS NOT NULL;
        -- Resolution asks only for links, and only ever by path. A partial
        -- index keeps that query proportional to the number of links rather
        -- than to the size of the namespace.
        CREATE INDEX vfs_entries_symlink
          ON vfs_entries(path) WHERE kind = 'symlink';`;

/**
 * The row-shape guards SQLite enforces rather than JavaScript.
 *
 * Recreated wholesale by the version-2 rebuild, because `ALTER TABLE ...
 * RENAME` does two different things to them. The four attached to the entry
 * table follow it to its temporary name and are dropped with it. The two
 * attached to `vfs_opaque_objects` and `vfs_inline_chunks` survive — but
 * SQLite rewrites their bodies to reference the renamed table, leaving them
 * guarding a table that no longer exists. Dropping all six by name and
 * reinstalling this one definition is what keeps a migrated database enforcing
 * exactly what a fresh one does.
 */
const ENTRY_TRIGGERS = `
        CREATE TRIGGER vfs_opaque_entry_insert_guard
          BEFORE INSERT ON vfs_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER vfs_opaque_entry_update_guard
          BEFORE UPDATE OF content_class, opaque_object_id ON vfs_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER vfs_inline_entry_delete_guard
          BEFORE DELETE ON vfs_entries
          WHEN EXISTS (
            SELECT 1 FROM vfs_inline_chunks WHERE entry_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;
        CREATE TRIGGER vfs_inline_entry_update_guard
          BEFORE UPDATE OF content_class ON vfs_entries
          WHEN OLD.content_class = 'inline' AND NEW.content_class <> 'inline'
            AND EXISTS (
              SELECT 1 FROM vfs_inline_chunks WHERE entry_id = OLD.id
            )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;
        CREATE TRIGGER vfs_opaque_object_delete_guard
          BEFORE DELETE ON vfs_opaque_objects
          WHEN EXISTS (
            SELECT 1 FROM vfs_entries WHERE opaque_object_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object is still referenced'); END;
        CREATE TRIGGER vfs_inline_chunk_insert_guard
          BEFORE INSERT ON vfs_inline_chunks
          WHEN NOT EXISTS (
            SELECT 1 FROM vfs_entries
            WHERE id = NEW.entry_id AND content_class = 'inline'
          )
          BEGIN SELECT RAISE(ABORT, 'inline chunk has no inline entry'); END;`;

const DROP_ENTRY_TRIGGERS = `
        DROP TRIGGER IF EXISTS vfs_opaque_entry_insert_guard;
        DROP TRIGGER IF EXISTS vfs_opaque_entry_update_guard;
        DROP TRIGGER IF EXISTS vfs_inline_entry_delete_guard;
        DROP TRIGGER IF EXISTS vfs_inline_entry_update_guard;
        DROP TRIGGER IF EXISTS vfs_opaque_object_delete_guard;
        DROP TRIGGER IF EXISTS vfs_inline_chunk_insert_guard;`;

const ENTRY_COLUMNS = `
  e.id, e.path, e.parent_path, e.name, e.kind, e.content_class,
  e.opaque_object_id, e.link_target, e.size_bytes, e.mode, e.uid, e.gid, e.created_at_ms,
  e.modified_at_ms, e.revision, p.version AS mutation_version
`;

export type VfsSqlRow = Readonly<Record<string, SqlStorageValue>>;
export type VfsSqlBinding = SqlStorageValue | Uint8Array;

export interface VfsSqlCursor<Row extends VfsSqlRow> {
  one(): Row;
  toArray(): Row[];
}

export interface VfsSqlStorage {
  readonly databaseSize: number;
  exec<Row extends VfsSqlRow>(query: string, ...bindings: VfsSqlBinding[]): VfsSqlCursor<Row>;
}

export interface SqlFileSystemStorage {
  readonly sql: VfsSqlStorage;
  execBatch(query: string): void;
  transactionSync<Result>(callback: () => Result): Result;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

type SqlRow = VfsSqlRow;

interface EntryRow {
  id: number;
  path: string;
  parentPath: string;
  name: string;
  kind: EntryKind;
  contentClass: "inline" | "opaque" | null;
  opaqueObjectId: number | null;
  linkTarget: string | null;
  sizeBytes: number;
  mode: number;
  uid: number;
  gid: number;
  createdAtMs: number;
  modifiedAtMs: number;
  revision: number;
  mutationToken: string;
}

interface CreationParents {
  readonly existing: EntryRow;
  readonly missing: readonly string[];
}

interface OpaqueObjectRow {
  id: number;
  key: string;
  sizeBytes: number;
  etag: string;
  version: string;
  verifiedSha256: string | null;
  contentType: string | null;
  retainUntilMs: number;
}

interface UploadRow {
  id: string;
  path: string;
  expectedMutationToken: string;
  objectKey: string;
  state: "open" | "verifying" | "committed" | "garbage";
  verificationToken: string | null;
  expectedSizeBytes: number | null;
  expiresAtMs: number;
  verificationLeaseUntilMs: number | null;
  createParents: boolean;
  mode: number | null;
  contentType: string | null;
  receiptJson: string | null;
}

export interface SqlFileSystemOptions extends CommonFileSystemOptions {
  maxDatabaseBytes?: number;
  minDatabaseHeadroomBytes?: number;
}

function invalidColumn(column: string, expected: string): never {
  throw new VfsError("EIO", `invalid SQLite row: ${column} must be ${expected}`);
}

function stringColumn(row: SqlRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : invalidColumn(column, "text");
}

function nullableStringColumn(row: SqlRow, column: string): string | null {
  const value = row[column];
  return value === null || typeof value === "string"
    ? value
    : invalidColumn(column, "text or null");
}

function integerColumn(row: SqlRow, column: string): number {
  const value = row[column];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : invalidColumn(column, "a safe integer");
}

function nullableIntegerColumn(row: SqlRow, column: string): number | null {
  const value = row[column];
  return value === null || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : invalidColumn(column, "a safe integer or null");
}

function blobColumn(row: SqlRow, column: string): ArrayBuffer {
  const value = row[column];
  return value instanceof ArrayBuffer ? value : invalidColumn(column, "a blob");
}

function firstRow(cursor: VfsSqlCursor<SqlRow>): SqlRow | undefined {
  return cursor.toArray()[0];
}

function formatMutationToken(epoch: string, version: number): string {
  return `${epoch}:${version}`;
}

function parseEntry(row: SqlRow, mutationEpoch: string): EntryRow {
  const kind = stringColumn(row, "kind");
  const contentClass = nullableStringColumn(row, "content_class");
  const opaqueObjectId = nullableIntegerColumn(row, "opaque_object_id");
  const linkTarget = nullableStringColumn(row, "link_target");
  if (kind !== "directory" && kind !== "file" && kind !== "symlink") {
    invalidColumn("kind", "directory, file, or symlink");
  }
  if (contentClass !== null && contentClass !== "inline" && contentClass !== "opaque") {
    invalidColumn("content_class", "inline, opaque, or null");
  }
  if (
    (kind === "directory" && (contentClass !== null || opaqueObjectId !== null)) ||
    (kind === "file" && contentClass === null) ||
    (contentClass === "inline" && opaqueObjectId !== null) ||
    (contentClass === "opaque" && opaqueObjectId === null) ||
    (kind === "symlink") !== (linkTarget !== null)
  ) {
    throw new VfsError("EIO", "invalid SQLite entry state", stringColumn(row, "path"));
  }
  return {
    id: integerColumn(row, "id"),
    path: stringColumn(row, "path"),
    parentPath: stringColumn(row, "parent_path"),
    name: stringColumn(row, "name"),
    kind,
    contentClass,
    linkTarget,
    opaqueObjectId,
    sizeBytes: integerColumn(row, "size_bytes"),
    mode: integerColumn(row, "mode"),
    uid: integerColumn(row, "uid"),
    gid: integerColumn(row, "gid"),
    createdAtMs: integerColumn(row, "created_at_ms"),
    modifiedAtMs: integerColumn(row, "modified_at_ms"),
    revision: integerColumn(row, "revision"),
    mutationToken: formatMutationToken(mutationEpoch, integerColumn(row, "mutation_version")),
  };
}

function rowToStat(row: EntryRow): VfsStat {
  const common = {
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    sizeBytes: row.sizeBytes,
    mode: row.mode,
    uid: row.uid,
    gid: row.gid,
    createdAtMs: row.createdAtMs,
    modifiedAtMs: row.modifiedAtMs,
    revision: row.revision,
    mutationToken: row.mutationToken,
  };
  if (row.kind === "directory") return { ...common, kind: "directory", contentClass: null };
  if (row.kind === "symlink") {
    if (row.linkTarget === null) throw new VfsError("EIO", "invalid SQLite entry state", row.path);
    return { ...common, kind: "symlink", contentClass: null, linkTarget: row.linkTarget };
  }
  if (row.contentClass === "inline") return { ...common, kind: "file", contentClass: "inline" };
  if (row.contentClass === "opaque") return { ...common, kind: "file", contentClass: "opaque" };
  throw new VfsError("EIO", "invalid SQLite entry state", row.path);
}

function parseOpaqueObject(row: SqlRow): OpaqueObjectRow {
  return {
    id: integerColumn(row, "id"),
    key: stringColumn(row, "r2_key"),
    sizeBytes: integerColumn(row, "size_bytes"),
    etag: stringColumn(row, "etag"),
    version: stringColumn(row, "r2_version"),
    verifiedSha256: nullableStringColumn(row, "verified_sha256"),
    contentType: nullableStringColumn(row, "content_type"),
    retainUntilMs: integerColumn(row, "retain_until_ms"),
  };
}

function parseUpload(row: SqlRow): UploadRow {
  const state = stringColumn(row, "state");
  if (state !== "open" && state !== "verifying" && state !== "committed" && state !== "garbage") {
    invalidColumn("state", "a valid upload state");
  }
  return {
    id: stringColumn(row, "id"),
    path: stringColumn(row, "path"),
    expectedMutationToken: stringColumn(row, "expected_mutation_token"),
    objectKey: stringColumn(row, "r2_key"),
    state,
    verificationToken: nullableStringColumn(row, "verification_token"),
    expectedSizeBytes: nullableIntegerColumn(row, "expected_size_bytes"),
    expiresAtMs: integerColumn(row, "expires_at_ms"),
    verificationLeaseUntilMs: nullableIntegerColumn(row, "verification_lease_until_ms"),
    createParents: integerColumn(row, "create_parents") === 1,
    mode: nullableIntegerColumn(row, "mode"),
    contentType: nullableStringColumn(row, "content_type"),
    receiptJson: nullableStringColumn(row, "receipt_json"),
  };
}

function metadataFromObject(row: OpaqueObjectRow): OpaqueObjectMetadata {
  return {
    key: row.key,
    sizeBytes: row.sizeBytes,
    etag: row.etag,
    version: row.version,
    ...(row.contentType === null ? {} : { contentType: row.contentType }),
    ...(row.verifiedSha256 === null ? {} : { verifiedSha256: row.verifiedSha256 }),
  };
}

export class SqlFileSystem implements PosixVirtualFileSystem {
  private readonly storage: SqlFileSystemStorage;
  private readonly sql: VfsSqlStorage;
  private readonly chunkBytes: number;
  private readonly maxInlineFileBytes: number;
  private readonly maxInlineLogicalBytes: number;
  private readonly maxEntries: number;
  private readonly inFlightBytes: InFlightByteBudget;
  private readonly maxDatabaseBytes: number;
  private readonly minDatabaseHeadroomBytes: number;
  private readonly uploadSettlementGraceMs: number;
  private readonly receiptRetentionMs: number;
  private readonly opaqueStore: OpaqueStore | undefined;
  private readonly clock: () => number;
  private readonly createId: () => string;
  private readonly workspaceId: string;
  private readonly onEvent: VfsEventSink | undefined;
  private readonly mutationEpoch: string;
  /** Non-zero while a transaction body is on the stack. */
  private transactionDepth = 0;
  /**
   * `vfs_usage` as the running transaction has it.
   *
   * The row is a singleton that only this transaction can be changing, and a
   * transaction body never yields, so reading it once and applying each delta
   * in memory answers exactly what re-reading would — for the capacity checks
   * a single write makes twice, and for the total an observer is handed.
   */
  private transactionUsage: { inlineBytes: number; entries: number } | undefined;
  /** Set inside a transaction, reported once the commit is durable. */
  private pendingUsage: { inlineBytes: number; entries: number } | undefined;
  /**
   * How many links exist, so a namespace without any pays nothing for them.
   *
   * Resolution consults this before doing any extra work: at zero it is exactly
   * the single indexed lookup the filesystem made before links existed, which
   * is what keeps the common case from slowing down. The Durable Object owns
   * its database outright and runs single-threaded, so a cached count cannot go
   * stale behind another writer.
   */
  private symlinkCount: number;
  /**
   * Set when a delete or a copy may have changed the link count.
   *
   * The count is only ever consulted to answer "are there any links?", so
   * over-counting merely does correct work that turns out to be unnecessary,
   * while under-counting to zero would skip resolution entirely. Recomputing on
   * demand keeps that impossible, and a namespace with no links never reaches
   * the recompute at all.
   */
  private symlinkCountStale = false;

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

    for (const [name, value] of [
      ["maxDatabaseBytes", this.maxDatabaseBytes],
      ["minDatabaseHeadroomBytes", this.minDatabaseHeadroomBytes],
    ] as const)
      validatePositiveInteger(value, name);
    this.mutationEpoch = this.migrate();
    this.symlinkCount = this.countSymlinks();
  }

  forCredentials(credentials: PosixCredentials, options: PosixViewOptions = {}): VirtualFileSystem {
    return new PosixFileSystemView(this, posixContext(credentials, options));
  }

  private countSymlinks(): number {
    return integerColumn(
      this.sql
        .exec<SqlRow>("SELECT COUNT(*) AS links FROM vfs_entries WHERE kind = 'symlink'")
        .one(),
      "links",
    );
  }

  /** How many links exist, recomputed only when a mutation may have changed it. */
  private links(): number {
    if (this.symlinkCountStale) {
      this.symlinkCount = this.countSymlinks();
      this.symlinkCountStale = false;
    }
    return this.symlinkCount;
  }

  private now(): number {
    return this.clock();
  }

  private assertPermission(
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

  private assertOwner(
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

  private assertStickyRemoval(
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
  private assertTraverse(
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
    const placeholders = ordered.map(() => "?").join(", ");
    const rows = this.sql
      .exec<SqlRow>(
        `SELECT path, kind, mode, uid, gid
         FROM vfs_entries INDEXED BY vfs_entries_path
         WHERE path IN (${placeholders})`,
        ...ordered,
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

  private creationMode(
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

  private creationOwner(
    parent: EntryRow,
    access: PosixAccessContext | undefined,
  ): { uid: number; gid: number } {
    if (access === undefined) return { uid: 0, gid: 0 };
    return {
      uid: access.credentials.uid,
      gid: (parent.mode & SETGID_BIT) !== 0 ? parent.gid : access.credentials.gid,
    };
  }

  private permissionExpression(
    alias: string,
    access: PosixAccessContext,
  ): { sql: string; bindings: number[] } {
    const groups = [...access.groups];
    return {
      sql: `CASE
        WHEN ${alias}.uid = ? THEN ((${alias}.mode >> 6) & 7)
        WHEN ${alias}.gid IN (${groups.map(() => "?").join(", ")})
          THEN ((${alias}.mode >> 3) & 7)
        ELSE (${alias}.mode & 7)
      END`,
      bindings: [access.credentials.uid, ...groups],
    };
  }

  /**
   * Conservative recursive semantics: a set operation is atomic, so an
   * inaccessible descendant rejects the whole operation instead of exposing
   * or mutating a partial prefix. SQLite performs the preflight in one range
   * scan and returns at most the first denied path.
   */
  private assertSubtreePermissions(
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

  private assertSubtreeSticky(path: string, access: PosixAccessContext | undefined): void {
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

  private newToken(): string {
    return this.createId();
  }

  private transaction<T>(callback: () => T): T {
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
      const usage = this.pendingUsage;
      if (usage !== undefined) {
        this.pendingUsage = undefined;
        emitVfsEvent(this.onEvent, { type: "vfs.usage", ...usage });
      }
      return result;
    } catch (error) {
      this.pendingUsage = undefined;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (/SQLITE_FULL|database or disk is full/iu.test(message)) {
        throw new VfsError("ENOSPC", "SQLite database capacity is exhausted");
      }
      throw error;
    }
  }

  private migrate(): string {
    let migrated = false;
    const mutationEpoch = this.transaction(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS vfs_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at_ms INTEGER NOT NULL
        );
      `);
      const currentVersion = integerColumn(
        this.sql
          .exec<SqlRow>("SELECT COALESCE(MAX(version), 0) AS version FROM vfs_schema_migrations")
          .one(),
        "version",
      );
      const now = this.now();
      if (currentVersion < 1) {
        this.storage.execBatch(`
        CREATE TABLE vfs_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          mutation_epoch TEXT NOT NULL
        );
        CREATE TABLE vfs_path_versions (
          path TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 1)
        ) WITHOUT ROWID;
        CREATE TABLE vfs_opaque_objects (
          id INTEGER PRIMARY KEY,
          r2_key TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          etag TEXT NOT NULL,
          r2_version TEXT NOT NULL,
          verified_sha256 TEXT,
          content_type TEXT,
          retain_until_ms INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL
        );
${ENTRIES_SCHEMA}
        CREATE TABLE vfs_inline_chunks (
          entry_id INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          body BLOB NOT NULL,
          PRIMARY KEY (entry_id, chunk_index)
        ) WITHOUT ROWID;
        CREATE TABLE vfs_upload_sessions (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          expected_mutation_token TEXT NOT NULL,
          r2_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('open', 'verifying', 'committed', 'garbage')),
          verification_token TEXT,
          expected_size_bytes INTEGER,
          expires_at_ms INTEGER NOT NULL,
          verification_lease_until_ms INTEGER,
          create_parents INTEGER NOT NULL CHECK (create_parents IN (0, 1)),
          mode INTEGER,
          content_type TEXT,
          receipt_json TEXT
        ) WITHOUT ROWID;
        CREATE INDEX vfs_upload_expiry
          ON vfs_upload_sessions(state, expires_at_ms);
        CREATE TABLE vfs_gc_queue (
          r2_key TEXT PRIMARY KEY,
          not_before_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER NOT NULL,
          last_error TEXT
        ) WITHOUT ROWID;
        CREATE INDEX vfs_gc_due
          ON vfs_gc_queue(next_attempt_at_ms, not_before_ms);
        CREATE TABLE vfs_usage (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          inline_bytes INTEGER NOT NULL CHECK (inline_bytes >= 0),
          entries INTEGER NOT NULL CHECK (entries >= 1)
        );
${ENTRY_TRIGGERS}
        `);
        const now = this.now();
        this.sql.exec(
          `INSERT INTO vfs_state (singleton, mutation_epoch)
           VALUES (1, ?)`,
          this.newToken(),
        );
        this.sql.exec("INSERT INTO vfs_path_versions (path, version) VALUES ('/', 1)");
        this.sql.exec(
          `INSERT INTO vfs_entries (
             path, parent_path, name, kind, content_class, opaque_object_id,
             size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
           ) VALUES ('/', '/', '/', 'directory', NULL, NULL, 0, ?, 0, 0, 0, 0, 1)`,
          DIRECTORY_MODE,
        );
        this.sql.exec("INSERT INTO vfs_usage (singleton, inline_bytes, entries) VALUES (1, 0, 1)");
        this.sql.exec(
          "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (1, ?)",
          now,
        );
        migrated = true;
      }
      if (currentVersion < 2) {
        // SQLite cannot widen a CHECK constraint in place, so version 2 is the
        // standard rebuild: create the new shape, copy every row, swap. The
        // definition comes from `ENTRIES_SCHEMA`, the same text a fresh
        // database uses, so a migrated database and a new one cannot differ.
        if (currentVersion === 1) {
          this.storage.execBatch(`
${DROP_ENTRY_TRIGGERS}
        ALTER TABLE vfs_entries RENAME TO vfs_entries_v1;
        DROP INDEX vfs_entries_path;
        DROP INDEX vfs_entries_parent_name;
        DROP INDEX vfs_entries_opaque_object;
${ENTRIES_SCHEMA}
        INSERT INTO vfs_entries (
          id, path, parent_path, name, kind, content_class, opaque_object_id,
          link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
        )
        SELECT
          id, path, parent_path, name, kind, content_class, opaque_object_id,
          NULL, size_bytes, mode, 0, 0, created_at_ms, modified_at_ms, revision
        FROM vfs_entries_v1;
        DROP TABLE vfs_entries_v1;
${ENTRY_TRIGGERS}
      `);
        }
        this.sql.exec(
          "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (2, ?)",
          now,
        );
        migrated = true;
      }
      if (currentVersion < 3) {
        // Databases rebuilt above already use the current entry definition.
        // Only a database that was already at version 2 needs the two columns
        // added in place; existing entries become root-owned until a trusted
        // administrator assigns workspace ownership explicitly.
        if (currentVersion === 2) {
          this.storage.execBatch(`
        ALTER TABLE vfs_entries
          ADD COLUMN uid INTEGER NOT NULL DEFAULT 0
          CHECK (uid >= 0 AND uid <= 4294967295);
        ALTER TABLE vfs_entries
          ADD COLUMN gid INTEGER NOT NULL DEFAULT 0
          CHECK (gid >= 0 AND gid <= 4294967295);
      `);
        }
        this.sql.exec(
          "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (3, ?)",
          now,
        );
        migrated = true;
      }
      return stringColumn(
        this.sql.exec<SqlRow>("SELECT mutation_epoch FROM vfs_state WHERE singleton = 1").one(),
        "mutation_epoch",
      );
    });
    if (migrated) this.sql.exec("PRAGMA optimize");
    return mutationEpoch;
  }

  private rows(query: string, ...bindings: SqlStorageValue[]): EntryRow[] {
    return this.sql
      .exec<SqlRow>(query, ...bindings)
      .toArray()
      .map((row) => parseEntry(row, this.mutationEpoch));
  }

  private oneEntry(path: string): EntryRow | null {
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_path
       CROSS JOIN vfs_path_versions p
       WHERE e.path = ? AND p.path = e.path`,
        path,
      ),
    );
    return row === undefined ? null : parseEntry(row, this.mutationEpoch);
  }

  /**
   * The absolute form of a link target, read from the link's own parent.
   *
   * POSIX resolves a relative target against the directory holding the link,
   * not the working directory of whoever is looking, so a tree keeps meaning
   * the same thing wherever it is read from.
   */
  private linkDestination(row: EntryRow): string {
    const target = row.linkTarget ?? "";
    return target.startsWith("/") ? normalizePath(target) : normalizePath(target, row.parentPath);
  }

  /**
   * Finds the outermost link on the way to `path`, if there is one.
   *
   * A path that is not in the table either does not exist or lies under a
   * link, and only the second case needs more work. Asking for the ancestors
   * by exact path uses the partial link index and costs one query, rather than
   * one query per component.
   */
  private linkAncestor(path: string): EntryRow | null {
    const ancestors: string[] = [];
    for (let at = dirname(path); at !== "/"; at = dirname(at)) ancestors.push(at);
    if (ancestors.length === 0) return null;
    const placeholders = ancestors.map(() => "?").join(", ");
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e
       CROSS JOIN vfs_path_versions p
       WHERE e.kind = 'symlink' AND e.path IN (${placeholders}) AND p.path = e.path
       ORDER BY length(e.path) ASC
       LIMIT 1`,
        ...ancestors,
      ),
    );
    return row === undefined ? null : parseEntry(row, this.mutationEpoch);
  }

  /**
   * Resolves a pathname, following links in every component.
   *
   * This is the only place a link is ever followed. Everything that reads or
   * writes an entry goes through it, so a policy check, a loop bound, and the
   * rule that a relative target reads from the link's parent cannot be skipped
   * by a caller that has not thought about links.
   *
   * `follow` governs the final component only, which is the difference between
   * `stat` and `lstat`: the components leading up to it are always followed,
   * because a link in the middle of a path is not a thing a caller can act on.
   *
   * When the namespace holds no links at all this is one lookup, the same query
   * the filesystem made before links existed.
   */
  private resolveEntry(
    input: string,
    follow: boolean,
  ): { path: string; row: EntryRow | null; followed: string[] } {
    let path = input;
    // The links crossed on the way, so a guard can cover the whole chain
    // rather than only where it currently ends.
    const followed: string[] = [];
    for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops += 1) {
      const row = this.oneEntry(path);
      if (row === null) {
        if (this.links() === 0) return { path, row: null, followed };
        const ancestor = this.linkAncestor(path);
        if (ancestor === null) return { path, row: null, followed };
        followed.push(ancestor.path);
        path = normalizePath(
          `${this.linkDestination(ancestor)}/${path.slice(ancestor.path.length)}`,
        );
        continue;
      }
      if (row.kind !== "symlink" || !follow) return { path, row, followed };
      followed.push(row.path);
      path = this.linkDestination(row);
    }
    throw new VfsError("ELOOP", "too many levels of symbolic links", input);
  }

  /**
   * The mutation token for `path`, taken from a row already resolved for it.
   *
   * `oneEntry` joins `vfs_path_versions` and `parseEntry` builds the token from
   * that column, so a row in hand carries exactly what `tokenFor` would read.
   * Callers pass a row only when it was fetched at the same point as the
   * decision being made — never across an `await`, where re-reading is the
   * guard rather than a repeat of it.
   */
  private tokenOf(path: string, entry: EntryRow | null | undefined): string {
    return entry != null && entry.path === path ? entry.mutationToken : this.tokenFor(path);
  }

  /**
   * The token a guard is taken and checked against.
   *
   * A path that crosses a link means whatever the link currently says, so each
   * link's own version is part of what the caller reserved. Without them,
   * repointing a link between the read and the write is invisible whenever the
   * old and new targets happen to share a version — the exact ABA the token
   * exists to catch.
   */
  private guardToken(path: string, entry?: EntryRow | null): string {
    const normalized = normalizePath(path);
    // With no links the guard is the named path's own token, which is what a
    // row resolved for that same path holds. With links it also covers every
    // one crossed, and those have no row here.
    if (this.links() === 0) return this.tokenOf(normalized, entry);
    const resolved = this.resolveEntry(normalized, true);
    const base = this.tokenFor(resolved.path);
    if (resolved.followed.length === 0) return base;
    return [base, ...resolved.followed.map((link) => this.tokenFor(link))].join("|");
  }

  /**
   * Canonicalizes a path, keeping a final component that does not exist.
   *
   * A caller canonicalizing the destination of a write it has not made yet
   * needs an answer, and refusing would make the policy check below depend on
   * whether the file happened to be there already.
   */
  realpath(path: string, options: { follow?: boolean } = {}, access?: PosixAccessContext): string {
    const normalized = normalizePath(path);
    if (this.links() === 0) {
      this.assertTraverse(normalized, [], access);
      return normalized;
    }
    const resolved = this.resolveEntry(normalized, options.follow !== false);
    this.assertTraverse(resolved.path, resolved.followed, access);
    // Already canonical, present or not: `resolveEntry` substitutes every link
    // ancestor before it gives up, so an absent final component is reported
    // under a path whose parents have all been resolved. Recursing on the
    // parent to "finish the job" would redo that walk once per component, and
    // the hop bound does not apply to depth — a four-thousand-byte path is
    // legal and would cost seconds of uninterruptible CPU.
    return resolved.path;
  }

  private oneResolved(path: string, follow = true): EntryRow | null {
    return this.resolveEntry(path, follow).row;
  }

  private requireEntry(path: string, follow = true): EntryRow {
    const row = this.oneResolved(path, follow);
    if (row === null) throw new VfsError("ENOENT", "no such file or directory", path);
    return row;
  }

  private requireDirectory(path: string, resolved?: EntryRow | null): EntryRow {
    // The row resolution already landed on, when the caller has it.
    const row = resolved ?? this.requireEntry(path);
    if (row.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", path);
    return row;
  }

  private requireInline(path: string, resolved?: EntryRow | null): EntryRow {
    // The row resolution already landed on, when the caller has it: looking it
    // up again would resolve the same path a second time.
    const row = resolved ?? this.requireEntry(path);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (row.contentClass !== "inline") {
      throw new VfsError("ENOTSUP", "opaque R2 content is not available to shell commands", path);
    }
    return row;
  }

  /**
   * Normalizes a path and resolves every link in it to a canonical one.
   *
   * Every operation goes through here, so the paths that reach the table are
   * always canonical: a link can never end up as the parent of an entry, which
   * is what lets an exact-path hit be trusted without walking the components.
   *
   * `followTerminal` is false for the operations that act on a link rather than
   * through it — `rm`, `mv`, `cp`, and `mkdir` name the link itself.
   */
  /**
   * Resolves a path to a canonical one and keeps the entry it landed on.
   *
   * Returning the row rather than only the path is what lets a caller act on a
   * link it asked not to follow. Looking the path up again afterwards would
   * resolve it a second time — with the follow flag lost — and a `rm` of a
   * dangling or cyclic link would fail on the target that is not there.
   *
   * `followTerminal` is false for the operations that name a link rather than
   * reach through it: `rm`, `mv`, `cp -P`, `mkdir`, and `ln -sf`.
   */
  private resolveAccess(
    path: string,
    allowMissingDirectory = false,
    followTerminal = true,
  ): { path: string; row: EntryRow | null; followed: string[] } {
    // A trailing slash asserts that the path names a directory, so the link is
    // followed even when the caller asked not to follow one: `rm dirlink/` is
    // a question about the directory, not about the link.
    const requiresDirectory = pathRequiresDirectory(path);
    const normalized = normalizePath(path);
    // With no links there is nothing to resolve and no row to fetch, so this
    // costs exactly what it did before links existed: nothing.
    const resolved =
      this.links() === 0
        ? { path: normalized, row: null, followed: [] }
        : this.resolveEntry(normalized, followTerminal || requiresDirectory);
    if (requiresDirectory && resolved.row === null && resolved.path !== "/") {
      resolved.row = this.oneEntry(resolved.path);
    }
    if (!requiresDirectory || resolved.path === "/") return resolved;
    if (resolved.row === null) {
      if (allowMissingDirectory) return resolved;
      throw new VfsError("ENOENT", "no such directory", resolved.path);
    }
    if (resolved.row.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", resolved.path);
    }
    return resolved;
  }

  private normalizeAccessPath(
    path: string,
    allowMissingDirectory = false,
    followTerminal = true,
  ): string {
    return this.resolveAccess(path, allowMissingDirectory, followTerminal).path;
  }

  private tokenFor(path: string): string {
    const current = firstRow(
      this.sql.exec<SqlRow>("SELECT version FROM vfs_path_versions WHERE path = ?", path),
    );
    if (current !== undefined) {
      return formatMutationToken(this.mutationEpoch, integerColumn(current, "version"));
    }
    return NEVER_MUTATED_TOKEN;
  }

  private publishPathVersion(path: string): number {
    return integerColumn(
      this.sql
        .exec<SqlRow>(
          `INSERT INTO vfs_path_versions (path, version) VALUES (?, 1)
         ON CONFLICT(path) DO UPDATE SET version = vfs_path_versions.version + 1
         RETURNING version`,
          path,
        )
        .one(),
      "version",
    );
  }

  private bumpToken(path: string): string {
    return formatMutationToken(this.mutationEpoch, this.publishPathVersion(path));
  }

  private validateGuard(
    path: string,
    entry: EntryRow | null,
    guard: { ifRevision?: number; ifMutationToken?: string },
    written?: string,
  ): void {
    if (guard.ifRevision !== undefined && entry?.revision !== guard.ifRevision) {
      throw new VfsError("EREVISION", "file revision does not match", path);
    }
    if (guard.ifMutationToken === undefined) return;
    // Checked against the path the caller named, not the one it resolved to,
    // so the token covers every link crossed on the way. `getMutationToken`
    // composes it the same way from the same written path.
    const current =
      written === undefined ? this.tokenOf(path, entry) : this.guardToken(written, entry);
    if (current !== guard.ifMutationToken) {
      throw new VfsError("EREVISION", "path mutation token does not match", path);
    }
  }

  private usage(): { inlineBytes: number; entries: number } {
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

  private updateUsage(inlineDelta: number, entryDelta: number): void {
    this.sql.exec(
      `UPDATE vfs_usage SET
         inline_bytes = inline_bytes + ?, entries = entries + ?
       WHERE singleton = 1`,
      inlineDelta,
      entryDelta,
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
  private quotaExceeded(
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

  private assertCapacity(inlineDelta: number, entryDelta: number, path?: string): void {
    const usage = this.usage();
    if (usage.inlineBytes + inlineDelta > this.maxInlineLogicalBytes) {
      this.quotaExceeded(
        "maxInlineLogicalBytes",
        inlineDelta,
        usage.inlineBytes,
        this.maxInlineLogicalBytes,
        "workspace inline-byte quota exceeded",
        path,
      );
    }
    if (usage.entries + entryDelta > this.maxEntries) {
      this.quotaExceeded(
        "maxEntries",
        entryDelta,
        usage.entries,
        this.maxEntries,
        "filesystem entry quota exceeded",
        path,
      );
    }
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

  private subtreeSummary(path: string): { entries: number; inlineBytes: number } {
    const range = descendantRange(path);
    const row = this.sql
      .exec<SqlRow>(
        `SELECT COUNT(*) AS entries,
              COALESCE(SUM(CASE WHEN content_class = 'inline' THEN size_bytes ELSE 0 END), 0)
                AS inline_bytes
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
    };
  }

  private publishSubtreeVersions(path: string): void {
    const range = descendantRange(path);
    this.sql.exec(
      `INSERT INTO vfs_path_versions (path, version)
       SELECT path, 1 FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)
       ON CONFLICT(path) DO UPDATE SET version = vfs_path_versions.version + 1`,
      path,
      range.lower,
      range.upper,
    );
  }

  private publishTranslatedSubtreeVersions(source: string, target: string): void {
    const range = descendantRange(source);
    this.sql.exec(
      `INSERT INTO vfs_path_versions (path, version)
       SELECT ? || substr(path, ?), 1 FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)
       ON CONFLICT(path) DO UPDATE SET version = vfs_path_versions.version + 1`,
      target,
      source.length + 1,
      source,
      range.lower,
      range.upper,
    );
  }

  private createDirectory(
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
    const token = this.bumpToken(path);
    const inserted = this.sql
      .exec<SqlRow>(
        `INSERT INTO vfs_entries (
         path, parent_path, name, kind, content_class, opaque_object_id,
         size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
       ) VALUES (?, ?, ?, 'directory', NULL, NULL, 0, ?, ?, ?, ?, ?, 1)
       RETURNING id`,
        path,
        dirname(path),
        basename(path),
        effectiveMode,
        owner.uid,
        owner.gid,
        now,
        now,
      )
      .one();
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
      mutationToken: token,
    };
  }

  private creationParents(path: string, recursive: boolean): CreationParents {
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

  private assertCreationAccess(
    path: string,
    followed: readonly string[],
    access: PosixAccessContext | undefined,
    parent: EntryRow,
  ): void {
    if (access === undefined) return;
    this.assertTraverse(parent.path, followed, access);
    this.assertPermission(parent, access, WRITE_PERMISSION | EXECUTE_PERMISSION, path);
  }

  private prepareParents(
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

  private createMissingParents(
    path: string,
    now: number,
    access: PosixAccessContext | undefined,
    parents: CreationParents,
  ): EntryRow {
    this.assertCapacity(0, parents.missing.length, path);
    let parent = parents.existing;
    for (const missingParent of parents.missing) {
      parent = this.createDirectory(missingParent, now, DIRECTORY_MODE, access, true, parent);
    }
    return parent;
  }

  private assertWriteAccess(
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

  private assertDestinationReplaceable(
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

  private async collectInline(body: ByteBody) {
    try {
      return await collectInlineBytes(
        body,
        this.maxInlineFileBytes,
        this.chunkBytes,
        this.inFlightBytes,
      );
    } catch (error) {
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
  }

  private useBuffered<T>(
    buffered: { chunks: Uint8Array[]; sizeBytes: number; release(): void },
    operation: (chunks: Uint8Array[], sizeBytes: number) => T,
  ): T {
    try {
      return operation(buffered.chunks, buffered.sizeBytes);
    } finally {
      buffered.release();
    }
  }

  stat(path: string, access?: PosixAccessContext): VfsStat {
    return this.statEntry(path, true, access);
  }

  /** Reports a link as itself rather than as what it points at. */
  lstat(path: string, access?: PosixAccessContext): VfsStat {
    return this.statEntry(path, false, access);
  }

  readlink(path: string, access?: PosixAccessContext): string {
    const resolved = this.accessEntry(path, false);
    this.assertTraverse(resolved.path, resolved.followed, access);
    const row = resolved.row;
    if (row === null) throw new VfsError("ENOENT", "no such file or directory", resolved.path);
    if (row.kind !== "symlink" || row.linkTarget === null) {
      throw new VfsError("EINVAL", "not a symbolic link", row.path);
    }
    return row.linkTarget;
  }

  /**
   * Resolves a path once and keeps the row it landed on.
   *
   * Normalizing and then looking up would resolve the same path twice, which
   * would double what every read costs as soon as a single link exists
   * anywhere in the namespace.
   */
  private accessEntry(
    path: string,
    follow: boolean,
  ): { path: string; row: EntryRow | null; followed: string[] } {
    const requiresDirectory = pathRequiresDirectory(path);
    const resolved = this.resolveEntry(normalizePath(path), follow || requiresDirectory);
    if (requiresDirectory && resolved.row !== null && resolved.row.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", resolved.path);
    }
    return resolved;
  }

  private statEntry(path: string, follow: boolean, posix?: PosixAccessContext): VfsStat {
    const access = this.accessEntry(path, follow);
    this.assertTraverse(access.path, access.followed, posix);
    if (access.row === null) {
      throw new VfsError("ENOENT", "no such file or directory", access.path);
    }
    const row = access.row;
    const stat = rowToStat(row);
    if (stat.kind !== "file" || stat.contentClass !== "opaque" || row.opaqueObjectId === null) {
      return stat;
    }
    const object = this.opaqueObject(row.opaqueObjectId);
    if (object === null) throw new VfsError("EIO", "opaque object metadata is missing", row.path);
    return {
      ...stat,
      ...(object.contentType === null ? {} : { contentType: object.contentType }),
      ...(object.verifiedSha256 === null ? {} : { verifiedSha256: object.verifiedSha256 }),
    };
  }

  getMutationToken(
    path: string,
    options: MutationTokenOptions = {},
    access?: PosixAccessContext,
  ): string {
    // Resolved by default, so the token belongs to the row the matching write
    // would guard. Reading it from the written path would return the link's
    // version and never match the target's.
    if (access === undefined) {
      return this.transaction(() =>
        options.follow === false
          ? this.tokenFor(this.normalizeAccessPath(path, true, false))
          : this.guardToken(path),
      );
    }
    return this.transaction(() => {
      const resolved = this.resolveAccess(path, true, options.follow !== false);
      this.assertTraverse(resolved.path, resolved.followed, access);
      return options.follow === false ? this.tokenFor(resolved.path) : this.guardToken(path);
    });
  }

  list(path: string, posix?: PosixAccessContext): VfsStat[] {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const directory = this.requireDirectory(normalized, access.row);
    this.assertPermission(directory, posix, READ_PERMISSION | EXECUTE_PERMISSION, normalized);
    return this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_parent_name
       CROSS JOIN vfs_path_versions p
       WHERE e.parent_path = ? AND e.path <> '/' AND p.path = e.path
       ORDER BY e.name`,
      normalized,
    ).map(rowToStat);
  }

  listPage(path: string, options: PageOptions = {}, posix?: PosixAccessContext): EntryPage {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const directory = this.requireDirectory(normalized, access.row);
    this.assertPermission(directory, posix, READ_PERMISSION | EXECUTE_PERMISSION, normalized);
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    const rows = this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_parent_name
       CROSS JOIN vfs_path_versions p
       WHERE e.parent_path = ? AND e.path <> '/' AND e.path > ?
         AND p.path = e.path
       ORDER BY e.path LIMIT ?`,
      normalized,
      options.cursor ?? "",
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map(rowToStat),
      nextCursor: rows.length > limit ? (page.at(-1)?.path ?? null) : null,
      scanned: page.length,
    };
  }

  find(options: FindOptions, access?: PosixAccessContext): VfsStat[] {
    const maximum = options.limit ?? 10_000;
    const result: VfsStat[] = [];
    let cursor = options.cursor;
    const effectiveOptions =
      access === undefined
        ? options
        : { ...options, path: this.assertFindAccess(options.path, access) };
    do {
      const page = this.findPage({
        ...effectiveOptions,
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(maximum - result.length, 1000),
      });
      result.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && result.length < maximum);
    return result;
  }

  private assertFindAccess(path: string, posix: PosixAccessContext): string {
    const access = this.resolveAccess(path);
    const root = access.path;
    this.assertTraverse(root, access.followed, posix);
    const rootEntry = access.row ?? this.requireEntry(root);
    this.assertPermission(
      rootEntry,
      posix,
      rootEntry.kind === "directory" ? READ_PERMISSION | EXECUTE_PERMISSION : 0,
      root,
    );
    if (rootEntry.kind === "directory") {
      this.assertSubtreePermissions(root, posix, 0, READ_PERMISSION | EXECUTE_PERMISSION);
    }
    return root;
  }

  findPage(options: FindOptions, posix?: PosixAccessContext): EntryPage {
    const access = this.resolveAccess(options.path);
    const root = access.path;
    const rootEntry = access.row ?? this.requireEntry(root);
    if (posix !== undefined) this.assertFindAccess(options.path, posix);
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    const range = descendantRange(root);
    const cursor = options.cursor ?? (root === "/" ? "" : root);
    const includeRoot =
      options.cursor === undefined && (rootEntry.kind === "file" || (options.includeRoot ?? false));
    const namePattern = options.name === undefined ? undefined : globToRegExp(options.name);
    const pathPattern = options.pathGlob === undefined ? undefined : globToRegExp(options.pathGlob);
    const descendants =
      rootEntry.kind === "file"
        ? []
        : this.rows(
            `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_path
       CROSS JOIN vfs_path_versions p
       WHERE e.path >= ? AND e.path < ? AND e.path > ? AND e.path <> ?
         AND p.path = e.path
       ORDER BY e.path LIMIT ?`,
            range.lower,
            range.upper,
            cursor,
            root,
            limit + (includeRoot ? 0 : 1),
          );
    const scannedRows = (includeRoot ? [rootEntry, ...descendants] : descendants).slice(0, limit);
    const entries = scannedRows
      .filter((row) => {
        if (options.maxDepth !== undefined && depthFrom(root, row.path) > options.maxDepth)
          return false;
        if (options.type !== undefined && row.kind !== options.type) return false;
        if (namePattern !== undefined && !namePattern.test(row.name)) return false;
        if (pathPattern !== undefined && !pathPattern.test(row.path)) return false;
        return true;
      })
      .map(rowToStat);
    const hasMore = descendants.length + (includeRoot ? 1 : 0) > limit;
    return {
      entries,
      nextCursor: hasMore ? (scannedRows.at(-1)?.path ?? null) : null,
      scanned: scannedRows.length,
    };
  }

  countSubtree(path: string, posix?: PosixAccessContext): number {
    // A link names one entry and has no subtree, so the count does not follow
    // it. The callers are budget accounting for `rm`, `mv`, and `cp`, all of
    // which act on the link; following would also make a dangling one throw.
    const access = this.resolveAccess(path, false, false);
    this.assertTraverse(access.path, access.followed, posix);
    const entry = access.row ?? this.requireEntry(access.path, false);
    if (entry.kind === "symlink") return 1;
    this.assertSubtreePermissions(access.path, posix, 0, READ_PERMISSION | EXECUTE_PERMISSION);
    return this.subtreeSummary(access.path).entries;
  }

  /**
   * Internal shell-budget preflight with the permission semantics of the
   * mutation it is charging. In particular, rename does not need read access
   * to a source subtree merely because its entry count is used as a limit.
   */
  countPosixMutationSubtree(
    path: string,
    operation: PosixMutationOperation,
    posix?: PosixAccessContext,
  ): number {
    const access = this.resolveAccess(
      path,
      false,
      operation.kind === "copy" && operation.dereference,
    );
    const entry = access.row ?? this.requireEntry(access.path, false);
    this.assertTraverse(access.path, access.followed, posix);
    if (operation.kind === "copy") {
      if (entry.kind === "file") {
        this.assertPermission(entry, posix, READ_PERMISSION, access.path);
      } else if (entry.kind === "directory") {
        this.assertSubtreePermissions(
          access.path,
          posix,
          READ_PERMISSION,
          READ_PERMISSION | EXECUTE_PERMISSION,
        );
      }
    } else {
      const parent = this.requireDirectory(dirname(access.path));
      this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, access.path);
      this.assertStickyRemoval(parent, entry, posix, access.path);
      if (operation.kind === "remove-recursive" && entry.kind === "directory") {
        this.assertSubtreePermissions(access.path, posix, 0, WRITE_PERMISSION | EXECUTE_PERMISSION);
        this.assertSubtreeSticky(access.path, posix);
      }
    }
    return entry.kind === "symlink" ? 1 : this.subtreeSummary(access.path).entries;
  }

  readFile(path: string, posix?: PosixAccessContext): InlineReadResult {
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
    const chunks = this.sql
      .exec<SqlRow>(
        `SELECT body FROM vfs_inline_chunks
       WHERE entry_id = ? ORDER BY chunk_index`,
        entry.id,
      )
      .toArray()
      .map((row) => new Uint8Array(blobColumn(row, "body")).slice());
    const sizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    this.inFlightBytes.acquire(sizeBytes);
    return {
      stat: rowToStat(entry) as InlineFileStat,
      stream: streamFromChunks(chunks, () => {
        this.inFlightBytes.release(sizeBytes);
      }),
    };
  }

  private opaqueObject(id: number): OpaqueObjectRow | null {
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

  private upload(id: string): UploadRow | null {
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

  private queueGarbage(objectKey: string, notBeforeMs: number): void {
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

  private queueUploadGarbage(session: UploadRow, now: number): void {
    this.queueGarbage(
      session.objectKey,
      Math.max(now, session.expiresAtMs + this.uploadSettlementGraceMs),
    );
  }

  private queueObjectIfUnreferenced(objectId: number, now: number): boolean {
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

  private removeExact(path: string, now: number, bumpPath = true): number {
    const entry = this.oneEntry(path);
    if (entry === null) return 0;
    if (entry.contentClass === "inline") {
      this.sql.exec("DELETE FROM vfs_inline_chunks WHERE entry_id = ?", entry.id);
    }
    this.sql.exec("DELETE FROM vfs_entries WHERE id = ?", entry.id);
    if (entry.kind === "symlink") this.symlinkCountStale = true;
    if (bumpPath) this.bumpToken(path);
    this.updateUsage(entry.contentClass === "inline" ? -entry.sizeBytes : 0, -1);
    if (
      entry.contentClass === "opaque" &&
      entry.opaqueObjectId !== null &&
      this.queueObjectIfUnreferenced(entry.opaqueObjectId, now)
    )
      return 1;
    return 0;
  }

  private async scheduleGarbageAlarm(): Promise<void> {
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
    if (due === null) {
      if ((await this.storage.getAlarm()) !== null) await this.storage.deleteAlarm();
      return;
    }
    const current = await this.storage.getAlarm();
    if (current !== due) await this.storage.setAlarm(due);
  }

  async writeFile(
    path: string,
    body: ByteBody,
    options: WriteFileOptions = {},
    posix?: PosixAccessContext,
  ): Promise<WriteResult> {
    const access = this.resolveAccess(path, true);
    const normalized = access.path;
    const before = access.row ?? this.oneEntry(normalized);
    this.assertWriteAccess(
      normalized,
      before,
      options.createParents ?? false,
      access.followed,
      posix,
    );
    const disposition = options.disposition ?? "upsert";
    if (disposition === "create" && before !== null) {
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    if (disposition === "replace" && before === null) {
      throw new VfsError("ENOENT", "no such file", normalized);
    }
    if (before?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    this.validateGuard(normalized, before, options, path);
    const capturedToken = this.tokenOf(normalized, before);
    const buffered = await this.collectInline(body);

    let queued = false;
    const result = this.useBuffered(buffered, (chunks, sizeBytes) =>
      this.transaction(() => {
        const current = this.oneEntry(normalized);
        if (this.tokenOf(normalized, current) !== capturedToken) {
          throw new VfsError("EREVISION", "path changed while the body was streaming", normalized);
        }
        this.validateGuard(normalized, current, options, path);
        if (current?.kind === "directory")
          throw new VfsError("EISDIR", "is a directory", normalized);
        const now = this.now();
        const parent =
          current === null
            ? this.prepareParents(
                normalized,
                options.createParents ?? false,
                now,
                access.followed,
                posix,
              )
            : undefined;
        if (current !== null) {
          this.assertWriteAccess(normalized, current, false, access.followed, posix);
        }
        const entryOrParent = parent ?? current ?? this.requireDirectory(dirname(normalized));
        const previousInlineBytes = current?.contentClass === "inline" ? current.sizeBytes : 0;
        const inlineDelta = sizeBytes - previousInlineBytes;
        // An entry that is already there is proof of its own parent. Nothing
        // removes or replaces a directory while a child remains, and every
        // route that could reach the parent must delete the child first, which
        // bumps its version and so fails the token compared just above.
        // `touch` reaches the same conclusion by returning early; a write has
        // to say it, because it goes on to write.
        const owner =
          current === null
            ? posix === undefined
              ? { uid: 0, gid: 0 }
              : this.creationOwner(entryOrParent, posix)
            : { uid: current.uid, gid: current.gid };
        const mode =
          current === null
            ? posix === undefined
              ? (options.mode ?? FILE_MODE)
              : this.creationMode(options.mode ?? FILE_MODE, posix, entryOrParent, false)
            : posix === undefined
              ? (options.mode ?? current.mode)
              : current.mode;
        this.assertCapacity(inlineDelta, current === null ? 1 : 0, normalized);
        const token = this.bumpToken(normalized);
        if (current?.contentClass === "inline") {
          this.sql.exec("DELETE FROM vfs_inline_chunks WHERE entry_id = ?", current.id);
        }
        const written = this.sql
          .exec<SqlRow>(
            `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
         ) VALUES (?, ?, ?, ?, 'file', 'inline', NULL, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'inline', opaque_object_id = NULL,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms,
           revision = vfs_entries.revision + 1
         RETURNING id, revision`,
            current?.id ?? null,
            normalized,
            dirname(normalized),
            basename(normalized),
            sizeBytes,
            mode,
            owner.uid,
            owner.gid,
            current?.createdAtMs ?? now,
            now,
          )
          .one();
        const entryId = integerColumn(written, "id");
        for (const [index, chunk] of chunks.entries()) {
          this.sql.exec(
            "INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body) VALUES (?, ?, ?)",
            entryId,
            index,
            chunk,
          );
        }
        this.updateUsage(inlineDelta, current === null ? 1 : 0);
        if (
          current?.contentClass === "opaque" &&
          current.opaqueObjectId !== null &&
          this.queueObjectIfUnreferenced(current.opaqueObjectId, now)
        )
          queued = true;
        return {
          path: normalized,
          revision: integerColumn(written, "revision"),
          mutationToken: token,
          sizeBytes,
          created: current === null,
        };
      }),
    );
    if (queued) await this.scheduleGarbageAlarm();
    return result;
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
    const buffered = await this.collectInline(body);
    return this.useBuffered(buffered, (suffixChunks, suffixBytes) => {
      return this.transaction(() => {
        const current = this.requireInline(normalized);
        if (current.mutationToken !== capturedToken) {
          throw new VfsError("EREVISION", "path changed while the body was streaming", normalized);
        }
        this.validateGuard(normalized, current, options, path);
        this.assertTraverse(normalized, access.followed, posix);
        this.assertPermission(current, posix, WRITE_PERMISSION, normalized);
        if (suffixBytes === 0) {
          return {
            path: normalized,
            revision: current.revision,
            mutationToken: capturedToken,
            sizeBytes: current.sizeBytes,
            created: false,
          };
        }
        const sizeBytes = current.sizeBytes + suffixBytes;
        if (sizeBytes > this.maxInlineFileBytes) {
          emitVfsEvent(this.onEvent, {
            type: "vfs.quota",
            limit: "maxInlineFileBytes",
            requested: sizeBytes,
            used: current.sizeBytes,
            max: this.maxInlineFileBytes,
            path: normalized,
          });
          throw new VfsError(
            "EFBIG",
            `inline content exceeds the ${this.maxInlineFileBytes}-byte limit`,
            normalized,
          );
        }
        this.assertCapacity(suffixBytes, 0, normalized);
        const lastChunk = firstRow(
          this.sql.exec<SqlRow>(
            `SELECT chunk_index, body FROM vfs_inline_chunks
         WHERE entry_id = ? ORDER BY chunk_index DESC LIMIT 1`,
            current.id,
          ),
        );
        let firstChunkIndex = 0;
        let chunks = suffixChunks;
        if (lastChunk === undefined) {
          if (current.sizeBytes !== 0) {
            throw new VfsError("EIO", "inline file is missing stored chunks", normalized);
          }
        } else {
          const lastChunkIndex = integerColumn(lastChunk, "chunk_index");
          const tail = new Uint8Array(blobColumn(lastChunk, "body"));
          const expectedLastChunkIndex = Math.floor((current.sizeBytes - 1) / this.chunkBytes);
          const expectedTailBytes = current.sizeBytes - expectedLastChunkIndex * this.chunkBytes;
          if (
            current.sizeBytes === 0 ||
            lastChunkIndex !== expectedLastChunkIndex ||
            tail.byteLength !== expectedTailBytes
          ) {
            throw new VfsError("EIO", "inline file chunks do not match its size", normalized);
          }
          if (tail.byteLength === this.chunkBytes) {
            firstChunkIndex = lastChunkIndex + 1;
          } else {
            firstChunkIndex = lastChunkIndex;
            chunks = rechunk([tail, ...suffixChunks], this.chunkBytes);
          }
        }
        for (const [offset, chunk] of chunks.entries()) {
          this.sql.exec(
            `INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body) VALUES (?, ?, ?)
           ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body`,
            current.id,
            firstChunkIndex + offset,
            chunk,
          );
        }
        const now = this.now();
        const token = this.bumpToken(normalized);
        this.sql.exec(
          `UPDATE vfs_entries SET size_bytes = ?, modified_at_ms = ?, revision = revision + 1
         WHERE id = ?`,
          sizeBytes,
          now,
          current.id,
        );
        this.updateUsage(suffixBytes, 0);
        return {
          path: normalized,
          revision: current.revision + 1,
          mutationToken: token,
          sizeBytes,
          created: false,
        };
      });
    });
  }

  setMetadata(
    path: string,
    options: MetadataUpdateOptions,
    posix?: PosixAccessContext,
    writtenFollowed: readonly string[] = [],
  ): VfsStat {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    const followed =
      writtenFollowed.length === 0 ? access.followed : [...writtenFollowed, ...access.followed];
    this.assertTraverse(normalized, followed, posix);
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      this.assertTraverse(normalized, followed, posix);
      if (options.mode !== undefined) this.assertOwner(entry, posix, normalized);
      else if (posix !== undefined && posix.credentials.uid !== entry.uid) {
        this.assertPermission(entry, posix, WRITE_PERMISSION, normalized);
      }
      this.validateGuard(normalized, entry, options);
      const token = this.bumpToken(normalized);
      const modifiedAtMs = options.modifiedAtMs ?? this.now();
      this.sql.exec(
        `UPDATE vfs_entries SET mode = ?, modified_at_ms = ?, revision = revision + 1
         WHERE id = ?`,
        options.mode ?? entry.mode,
        modifiedAtMs,
        entry.id,
      );
      return rowToStat({
        ...entry,
        mode: options.mode ?? entry.mode,
        modifiedAtMs,
        revision: entry.revision + 1,
        mutationToken: token,
      });
    });
  }

  setOwnership(path: string, options: OwnershipUpdateOptions, posix?: PosixAccessContext): VfsStat {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    if (options.uid === undefined && options.gid === undefined) {
      throw new VfsError("EINVAL", "setOwnership requires uid or gid", normalized);
    }
    const uid = options.uid === undefined ? undefined : posixId(options.uid, "options.uid");
    const gid = options.gid === undefined ? undefined : posixId(options.gid, "options.gid");
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      this.assertTraverse(normalized, access.followed, posix);
      if (posix !== undefined && posix.credentials.uid !== 0) {
        if (uid !== undefined && uid !== entry.uid) {
          throw new VfsError("EPERM", "only root may change a file owner", normalized);
        }
        this.assertOwner(entry, posix, normalized);
        if (gid !== undefined && !posix.groups.has(gid)) {
          throw new VfsError("EPERM", "group is not in the current user's groups", normalized);
        }
      }
      this.validateGuard(normalized, entry, options);
      const token = this.bumpToken(normalized);
      const modifiedAtMs = this.now();
      const mode =
        posix !== undefined &&
        posix.credentials.uid !== 0 &&
        (uid !== undefined || gid !== undefined)
          ? entry.mode & ~0o6000
          : entry.mode;
      this.sql.exec(
        `UPDATE vfs_entries
         SET uid = ?, gid = ?, mode = ?, modified_at_ms = ?, revision = revision + 1
         WHERE id = ?`,
        uid ?? entry.uid,
        gid ?? entry.gid,
        mode,
        modifiedAtMs,
        entry.id,
      );
      return rowToStat({
        ...entry,
        uid: uid ?? entry.uid,
        gid: gid ?? entry.gid,
        mode,
        modifiedAtMs,
        revision: entry.revision + 1,
        mutationToken: token,
      });
    });
  }

  touch(path: string, options: TouchOptions = {}, posix?: PosixAccessContext): VfsStat {
    const access = this.resolveAccess(path, true);
    const normalized = access.path;
    const existing = access.row ?? this.oneEntry(normalized);
    if (existing !== null) {
      // `setMetadata` receives the canonical target below, so retain the
      // written side of any followed link here. Both sides need search
      // permission; otherwise `touch hidden/link` could reach an accessible
      // target through a directory the caller cannot traverse.
      return this.setMetadata(normalized, options, posix, access.followed);
    }
    if (options.create === false) {
      throw new VfsError("ENOENT", "no such file or directory", normalized);
    }
    return this.transaction(() => {
      const parents =
        posix === undefined
          ? undefined
          : this.creationParents(normalized, options.createParents ?? false);
      if (parents !== undefined) {
        this.assertCreationAccess(normalized, access.followed, posix, parents.existing);
      }
      this.validateGuard(normalized, null, options);
      const now = this.now();
      const parent =
        parents === undefined
          ? this.prepareParents(
              normalized,
              options.createParents ?? false,
              now,
              access.followed,
              posix,
            )
          : this.createMissingParents(normalized, now, posix, parents);
      const owner = posix === undefined ? { uid: 0, gid: 0 } : this.creationOwner(parent, posix);
      const mode =
        posix === undefined
          ? (options.mode ?? FILE_MODE)
          : this.creationMode(options.mode ?? FILE_MODE, posix, parent, false);
      this.assertCapacity(0, 1, normalized);
      const token = this.bumpToken(normalized);
      this.sql.exec(
        `INSERT INTO vfs_entries (
           path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
         ) VALUES (?, ?, ?, 'file', 'inline', NULL, 0, ?, ?, ?, ?, ?, 1)`,
        normalized,
        dirname(normalized),
        basename(normalized),
        mode,
        owner.uid,
        owner.gid,
        now,
        options.modifiedAtMs ?? now,
      );
      this.updateUsage(0, 1);
      return {
        path: normalized,
        parentPath: dirname(normalized),
        name: basename(normalized),
        kind: "file",
        contentClass: "inline",
        sizeBytes: 0,
        mode,
        uid: owner.uid,
        gid: owner.gid,
        createdAtMs: now,
        modifiedAtMs: options.modifiedAtMs ?? now,
        revision: 1,
        mutationToken: token,
      };
    });
  }

  mkdir(
    path: string,
    recursive = false,
    mode = DIRECTORY_MODE,
    posix?: PosixAccessContext,
  ): VfsStat {
    // An existing link at the path is an existing entry, so `mkdir` reports
    // EEXIST rather than creating a directory at whatever it points at.
    const access = this.resolveAccess(path, true, false);
    const normalized = access.path;
    return this.transaction(() => {
      const existing = access.row ?? this.oneEntry(normalized);
      if (existing !== null) {
        this.assertTraverse(normalized, access.followed, posix);
        if (recursive && existing.kind === "directory") {
          this.assertPermission(existing, posix, EXECUTE_PERMISSION, normalized);
          return rowToStat(existing);
        }
        throw new VfsError("EEXIST", "file or directory already exists", normalized);
      }
      const now = this.now();
      const parent = this.prepareParents(normalized, recursive, now, access.followed, posix);
      this.assertCapacity(0, 1, normalized);
      return rowToStat(this.createDirectory(normalized, now, mode, posix, false, parent));
    });
  }

  symlink(
    path: string,
    target: string,
    options: SymlinkOptions = {},
    posix?: PosixAccessContext,
  ): VfsStat {
    const access = this.resolveAccess(path, true, false);
    const normalized = access.path;
    const parentPath = dirname(normalized);
    const name = basename(normalized);
    if (normalized === "/") throw new VfsError("EEXIST", "file or directory exists", normalized);
    if (target.length === 0) throw new VfsError("EINVAL", "link target is empty", normalized);
    const bytes = new TextEncoder().encode(target).byteLength;
    if (bytes > MAX_SYMLINK_TARGET_BYTES) {
      throw new VfsError("ENAMETOOLONG", "link target is too long", normalized);
    }
    return this.transaction(() => {
      const existing = access.row ?? this.oneEntry(normalized);
      if (existing !== null) {
        if (!(options.replace ?? false)) {
          throw new VfsError("EEXIST", "file or directory exists", normalized);
        }
        if (existing.kind === "directory") {
          throw new VfsError("EISDIR", "is a directory", normalized);
        }
      }
      this.validateGuard(normalized, existing, {
        ...(options.ifMutationToken === undefined
          ? {}
          : { ifMutationToken: options.ifMutationToken }),
      });
      const now = this.now();
      const parent = this.prepareParents(
        normalized,
        options.createParents ?? false,
        now,
        access.followed,
        posix,
      );
      if (existing !== null && posix !== undefined) {
        this.assertStickyRemoval(parent, existing, posix, normalized);
      }
      if (existing !== null) this.removeExact(normalized, now, false);
      const owner = posix === undefined ? { uid: 0, gid: 0 } : this.creationOwner(parent, posix);
      this.assertCapacity(0, 1, normalized);
      const inserted = this.sql
        .exec<SqlRow>(
          `INSERT INTO vfs_entries (
             path, parent_path, name, kind, content_class, opaque_object_id,
             link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
          ) VALUES (?, ?, ?, 'symlink', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1)
           RETURNING id`,
          normalized,
          parentPath,
          name,
          target,
          bytes,
          SYMLINK_MODE,
          owner.uid,
          owner.gid,
          now,
          now,
        )
        .one();
      this.updateUsage(0, 1);
      const token = this.bumpToken(normalized);
      this.symlinkCount += 1;
      return rowToStat({
        id: integerColumn(inserted, "id"),
        path: normalized,
        parentPath,
        name,
        kind: "symlink",
        contentClass: null,
        opaqueObjectId: null,
        linkTarget: target,
        sizeBytes: bytes,
        mode: SYMLINK_MODE,
        uid: owner.uid,
        gid: owner.gid,
        createdAtMs: now,
        modifiedAtMs: now,
        revision: 1,
        mutationToken: token,
      });
    });
  }

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
    let queued = 0;
    const result = this.transaction(() => {
      // The row resolution already landed on, so a link whose target is
      // missing or cyclic is still removable — it is the link being removed.
      const root = access.row ?? this.requireEntry(normalized, false);
      this.assertTraverse(normalized, access.followed, posix);
      if (posix !== undefined) {
        const parent = this.requireDirectory(dirname(normalized));
        this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, normalized);
        this.assertStickyRemoval(parent, root, posix, normalized);
      }
      const range = descendantRange(normalized);
      const hasDescendants = firstRow(
        this.sql.exec<SqlRow>(
          `SELECT 1 AS present FROM vfs_entries
         WHERE path >= ? AND path < ? LIMIT 1`,
          range.lower,
          range.upper,
        ),
      );
      if (
        root.kind === "directory" &&
        hasDescendants !== undefined &&
        !(options.recursive ?? false)
      ) {
        throw new VfsError("ENOTEMPTY", "directory is not empty", normalized);
      }
      if (root.kind === "directory" && (options.recursive ?? false)) {
        this.assertSubtreePermissions(normalized, posix, 0, WRITE_PERMISSION | EXECUTE_PERMISSION);
        this.assertSubtreeSticky(normalized, posix);
      }
      const summary = this.subtreeSummary(normalized);
      const now = this.now();
      this.publishSubtreeVersions(normalized);
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
        normalized,
        range.lower,
        range.upper,
        normalized,
        range.lower,
        range.upper,
      );
      queued = integerColumn(this.sql.exec<SqlRow>("SELECT changes() AS value").one(), "value");
      this.sql.exec(
        `DELETE FROM vfs_inline_chunks
         WHERE entry_id IN (
           SELECT id FROM vfs_entries
           WHERE path = ? OR (path >= ? AND path < ?)
         )`,
        normalized,
        range.lower,
        range.upper,
      );
      this.sql.exec(
        `DELETE FROM vfs_entries
         WHERE path = ? OR (path >= ? AND path < ?)`,
        normalized,
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
      return {
        removed: summary.entries,
        opaqueObjectsQueuedForDeletion: queued,
      };
    });
    if (queued > 0) await this.scheduleGarbageAlarm();
    return result;
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
      if (posix === undefined) {
        return { from: source, to: target, moved: 1, replaced: false };
      }
      return this.transaction(() => {
        const entry = sourceAccess.row ?? this.requireEntry(source, false);
        this.assertTraverse(source, sourceAccess.followed, posix);
        const parent = this.requireDirectory(dirname(source));
        this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, source);
        this.assertStickyRemoval(parent, entry, posix, source);
        return { from: source, to: target, moved: 1, replaced: false };
      });
    }
    if (isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory into itself", target);
    }
    let queued = 0;
    const result = this.transaction(() => {
      const sourceEntry = sourceAccess.row ?? this.requireEntry(source, false);
      this.assertTraverse(source, sourceAccess.followed, posix);
      this.assertTraverse(target, targetAccess.followed, posix);
      const targetParent = this.requireDirectory(dirname(target));
      if (posix !== undefined) {
        const sourceParent = this.requireDirectory(dirname(source));
        this.assertPermission(sourceParent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, source);
        this.assertPermission(targetParent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, target);
        this.assertStickyRemoval(sourceParent, sourceEntry, posix, source);
      }
      const destination = targetAccess.row ?? this.oneEntry(target);
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
      const summary = this.subtreeSummary(source);
      const sourceRange = descendantRange(source);
      const now = this.now();
      if (destination !== null) queued += this.removeExact(target, now, false);
      this.publishSubtreeVersions(source);
      this.publishTranslatedSubtreeVersions(source, target);
      this.sql.exec(
        `UPDATE vfs_entries SET
           path = ? || substr(path, ?),
           parent_path = CASE WHEN path = ? THEN ?
             ELSE ? || substr(parent_path, ?) END,
           name = CASE WHEN path = ? THEN ? ELSE name END,
           modified_at_ms = CASE WHEN path = ? THEN ? ELSE modified_at_ms END,
           revision = revision + 1
         WHERE path = ? OR (path >= ? AND path < ?)`,
        target,
        source.length + 1,
        source,
        dirname(target),
        target,
        source.length + 1,
        source,
        basename(target),
        source,
        now,
        source,
        sourceRange.lower,
        sourceRange.upper,
      );
      return {
        from: source,
        to: target,
        moved: summary.entries,
        replaced: destination !== null,
      };
    });
    if (queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }

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
    if (source === target) {
      throw new VfsError("EINVAL", "source and destination are the same path", target);
    }
    let queued = 0;
    const result = this.transaction(() => {
      const sourceEntry = sourceAccess.row ?? this.requireEntry(source, false);
      this.assertTraverse(source, sourceAccess.followed, posix);
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
      const parents =
        posix === undefined
          ? undefined
          : this.creationParents(target, options.createParents ?? false);
      if (parents !== undefined) {
        this.assertCreationAccess(target, targetAccess.followed, posix, parents.existing);
      }
      const destination = targetAccess.row ?? this.oneEntry(target);
      this.assertDestinationReplaceable(destination, target, options.replace ?? false);
      const now = this.now();
      const preparedParent =
        parents === undefined
          ? this.prepareParents(
              target,
              options.createParents ?? false,
              now,
              targetAccess.followed,
              posix,
            )
          : this.createMissingParents(target, now, posix, parents);
      if (destination !== null && posix !== undefined) {
        this.assertStickyRemoval(preparedParent, destination, posix, target);
      }
      const targetParent = posix === undefined ? undefined : preparedParent;
      const owner =
        targetParent === undefined ? { uid: 0, gid: 0 } : this.creationOwner(targetParent, posix);
      const sourceRange = descendantRange(source);
      const summary = this.subtreeSummary(source);
      const replacedInlineBytes =
        destination?.contentClass === "inline" ? destination.sizeBytes : 0;
      this.assertCapacity(
        summary.inlineBytes - replacedInlineBytes,
        summary.entries - (destination === null ? 0 : 1),
        target,
      );
      if (destination !== null) queued += this.removeExact(target, now, false);
      this.publishTranslatedSubtreeVersions(source, target);
      if (posix === undefined) {
        this.sql.exec(
          `INSERT INTO vfs_entries (
           path, parent_path, name, kind, content_class, opaque_object_id,
           link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
         )
         SELECT
           ? || substr(e.path, ?),
           CASE WHEN e.path = ? THEN ?
             ELSE ? || substr(e.parent_path, ?) END,
           CASE WHEN e.path = ? THEN ? ELSE e.name END,
           e.kind, e.content_class, e.opaque_object_id,
           e.link_target, e.size_bytes, e.mode, e.uid, e.gid, ?, ?, 1
         FROM vfs_entries e
         WHERE e.path = ? OR (e.path >= ? AND e.path < ?)`,
          target,
          source.length + 1,
          source,
          dirname(target),
          target,
          source.length + 1,
          source,
          basename(target),
          now,
          now,
          source,
          sourceRange.lower,
          sourceRange.upper,
        );
      } else {
        // A user copy creates actor-owned entries. The recursive CTE carries
        // the effective mode and group from each copied parent so setgid
        // inheritance remains correct at every depth without issuing one
        // statement per entry. The trusted branch above deliberately keeps
        // its original range-copy query and exact SQL cost.
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
             path, parent_path, name, kind, content_class, opaque_object_id,
             link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
           )
           SELECT
             ? || substr(copied.path, ?),
             CASE WHEN copied.path = ? THEN ?
               ELSE ? || substr(copied.parent_path, ?) END,
             CASE WHEN copied.path = ? THEN ? ELSE copied.name END,
             copied.kind, copied.content_class, copied.opaque_object_id,
             copied.link_target, copied.size_bytes,
             copied.copied_mode, copied.copied_uid, copied.copied_gid, ?, ?, 1
           FROM copied`,
          ~posix.umask,
          targetParent?.mode ?? 0,
          SETGID_BIT,
          SETGID_BIT,
          owner.uid,
          owner.gid,
          source,
          ~posix.umask,
          SETGID_BIT,
          SETGID_BIT,
          posix.credentials.uid,
          SETGID_BIT,
          posix.credentials.gid,
          target,
          source.length + 1,
          source,
          dirname(target),
          target,
          source.length + 1,
          source,
          basename(target),
          now,
          now,
        );
      }
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
        source.length + 1,
        source,
        sourceRange.lower,
        sourceRange.upper,
      );
      // The copy is set-based and carries `kind` across, so it may have
      // produced links; the count is recomputed rather than guessed.
      this.symlinkCountStale = true;
      this.updateUsage(
        summary.inlineBytes - replacedInlineBytes,
        summary.entries - (destination === null ? 0 : 1),
      );
      return {
        from: source,
        to: target,
        copied: summary.entries,
        replaced: destination !== null,
        opaqueBodiesCopied: 0 as const,
      };
    });
    if (queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }

  async beginOpaqueUpload(
    path: string,
    options: BeginOpaqueUploadOptions = {},
  ): Promise<OpaqueUploadReservation> {
    if (this.opaqueStore === undefined) {
      throw new VfsError("ENOTSUP", "opaque storage is not configured");
    }
    const normalized = this.normalizeAccessPath(path, true);
    const existing = this.oneEntry(normalized);
    if (existing?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (
      options.expectedSizeBytes !== undefined &&
      (!Number.isSafeInteger(options.expectedSizeBytes) || options.expectedSizeBytes < 0)
    ) {
      throw new VfsError("EINVAL", "expectedSizeBytes must be a non-negative safe integer");
    }
    const expiresInMs = options.expiresInMs ?? DEFAULT_UPLOAD_TTL_MS;
    validatePositiveInteger(expiresInMs, "expiresInMs");
    const reservation = this.transaction(() => {
      this.assertCapacity(0, 0, normalized);
      const token = this.tokenFor(normalized);
      if (options.ifMutationToken !== undefined && options.ifMutationToken !== token) {
        throw new VfsError("EREVISION", "path mutation token does not match", normalized);
      }
      const uploadId = this.createId();
      const objectKey = `vfs/${this.workspaceId}/objects/${this.createId()}`;
      const expiresAtMs = this.now() + expiresInMs;
      this.sql.exec(
        `INSERT INTO vfs_upload_sessions (
           id, path, expected_mutation_token, r2_key, state,
           verification_token, expected_size_bytes, expires_at_ms,
           verification_lease_until_ms, create_parents, mode,
           content_type, receipt_json
         ) VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, NULL, ?, ?, ?, NULL)`,
        uploadId,
        normalized,
        token,
        objectKey,
        options.expectedSizeBytes ?? null,
        expiresAtMs,
        options.createParents === true ? 1 : 0,
        options.mode ?? null,
        options.contentType ?? null,
      );
      return {
        uploadId,
        path: normalized,
        objectKey,
        expectedMutationToken: token,
        expiresAtMs,
        ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      };
    });
    await this.scheduleGarbageAlarm();
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "begin",
      uploadId: reservation.uploadId,
      objectKey: reservation.objectKey,
      path: reservation.path,
    });
    return reservation;
  }

  private parseReceipt(value: string, path: string): OpaqueFileStat {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new VfsError("EIO", "invalid committed upload receipt", path);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new VfsError("EIO", "invalid committed upload receipt", path);
    }
    const receipt = parsed as Readonly<Record<string, unknown>>;
    const strings = ["path", "parentPath", "name", "mutationToken"] as const;
    const integers = [
      "sizeBytes",
      "mode",
      "uid",
      "gid",
      "createdAtMs",
      "modifiedAtMs",
      "revision",
    ] as const;
    if (
      receipt["kind"] !== "file" ||
      receipt["contentClass"] !== "opaque" ||
      strings.some((field) => typeof receipt[field] !== "string") ||
      integers.some(
        (field) => !Number.isSafeInteger(receipt[field]) || (receipt[field] as number) < 0,
      ) ||
      (receipt["revision"] as number) < 1 ||
      (receipt["contentType"] !== undefined && typeof receipt["contentType"] !== "string") ||
      (receipt["verifiedSha256"] !== undefined && typeof receipt["verifiedSha256"] !== "string")
    )
      throw new VfsError("EIO", "invalid committed upload receipt", path);
    return receipt as unknown as OpaqueFileStat;
  }

  private markUploadGarbage(
    uploadId: string,
    objectKey: string,
    verificationToken: string,
    now: number,
    reason?: string,
  ): boolean {
    const rejected = this.transaction(() => {
      const session = this.upload(uploadId);
      if (
        session === null ||
        session.state !== "verifying" ||
        session.objectKey !== objectKey ||
        session.verificationToken !== verificationToken
      )
        return false;
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ? AND state = 'verifying' AND verification_token = ?`,
        uploadId,
        verificationToken,
      );
      this.queueUploadGarbage(session, now);
      return { path: session.path };
    });
    if (rejected === false) return false;
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "reject",
      uploadId,
      objectKey,
      path: rejected.path,
      ...(reason === undefined ? {} : { reason }),
    });
    return true;
  }

  async commitOpaqueUpload(
    uploadId: string,
    options: CommitOpaqueUploadOptions = {},
  ): Promise<OpaqueFileStat> {
    const store = this.opaqueStore;
    if (store === undefined) throw new VfsError("ENOTSUP", "opaque storage is not configured");
    const started = this.transaction(() => {
      const session = this.upload(uploadId);
      if (session === null) throw new VfsError("ENOENT", "upload session does not exist");
      if (session.state === "committed" && session.receiptJson !== null) {
        if (session.expiresAtMs <= this.now()) {
          this.sql.exec("DELETE FROM vfs_upload_sessions WHERE id = ?", uploadId);
          return { expiredReceipt: session.path } as const;
        }
        return { committed: this.parseReceipt(session.receiptJson, session.path) } as const;
      }
      if (session.state === "garbage") {
        throw new VfsError("EREVISION", "upload session can no longer be committed", session.path);
      }
      const now = this.now();
      if (session.expiresAtMs <= now) {
        this.sql.exec("UPDATE vfs_upload_sessions SET state = 'garbage' WHERE id = ?", uploadId);
        this.queueUploadGarbage(session, now);
        return { expired: session } as const;
      }
      if (session.state === "verifying" && (session.verificationLeaseUntilMs ?? 0) > now)
        throw new VfsError("EAGAIN", "upload verification is already in progress", session.path);
      const verificationToken = this.newToken();
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'verifying', verification_token = ?, verification_lease_until_ms = ?
         WHERE id = ?`,
        verificationToken,
        now + DEFAULT_VERIFY_LEASE_MS,
        uploadId,
      );
      return { session, verificationToken } as const;
    });
    if ("expiredReceipt" in started) {
      await this.scheduleGarbageAlarm();
      throw new VfsError("ENOENT", "committed upload receipt expired", started.expiredReceipt);
    }
    if ("committed" in started) return started.committed;
    if ("expired" in started) {
      await this.scheduleGarbageAlarm();
      throw new VfsError("ETIMEDOUT", "upload session expired", started.expired.path);
    }
    await this.scheduleGarbageAlarm();

    let metadata: OpaqueObjectMetadata | null;
    try {
      metadata = await store.head(started.session.objectKey);
    } catch (error) {
      this.transaction(() => {
        this.sql.exec(
          `UPDATE vfs_upload_sessions SET
             state = 'open', verification_token = NULL,
             verification_lease_until_ms = NULL
           WHERE id = ? AND state = 'verifying' AND verification_token = ?`,
          uploadId,
          started.verificationToken,
        );
      });
      await this.scheduleGarbageAlarm();
      throw error;
    }
    if (metadata === null) {
      if (
        !this.markUploadGarbage(
          uploadId,
          started.session.objectKey,
          started.verificationToken,
          this.now(),
          "object-missing",
        )
      )
        throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      await this.scheduleGarbageAlarm();
      throw new VfsError("EIO", "uploaded R2 object is missing", started.session.path);
    }
    if (metadata.key !== started.session.objectKey) {
      if (
        !this.markUploadGarbage(
          uploadId,
          started.session.objectKey,
          started.verificationToken,
          this.now(),
          "key-mismatch",
        )
      )
        throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      await this.scheduleGarbageAlarm();
      throw new VfsError(
        "EIO",
        "object store returned metadata for the wrong key",
        started.session.path,
      );
    }
    if (
      started.session.expectedSizeBytes !== null &&
      metadata.sizeBytes !== started.session.expectedSizeBytes
    ) {
      if (
        !this.markUploadGarbage(
          uploadId,
          started.session.objectKey,
          started.verificationToken,
          this.now(),
          "size-mismatch",
        )
      )
        throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      await this.scheduleGarbageAlarm();
      throw new VfsError("EIO", "uploaded R2 object size does not match", started.session.path);
    }
    if (
      options.verifiedSha256 !== undefined &&
      options.verifiedSha256 !== metadata.verifiedSha256
    ) {
      if (
        !this.markUploadGarbage(
          uploadId,
          started.session.objectKey,
          started.verificationToken,
          this.now(),
          "digest-unverified",
        )
      )
        throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      await this.scheduleGarbageAlarm();
      throw new VfsError(
        "EINVAL",
        "SHA-256 was not verified by the trusted object store",
        started.session.path,
      );
    }

    const committed = this.transaction(() => {
      const session = this.upload(uploadId);
      if (
        session === null ||
        session.state !== "verifying" ||
        session.verificationToken !== started.verificationToken
      )
        throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      if (this.tokenFor(session.path) !== session.expectedMutationToken) {
        this.sql.exec(
          `UPDATE vfs_upload_sessions SET
             state = 'garbage', verification_token = NULL,
             verification_lease_until_ms = NULL
           WHERE id = ?`,
          uploadId,
        );
        this.queueUploadGarbage(session, this.now());
        return { stale: true, path: session.path, objectKey: session.objectKey } as const;
      }
      const existing = this.oneEntry(session.path);
      if (existing?.kind === "directory")
        throw new VfsError("EISDIR", "is a directory", session.path);
      const now = this.now();
      this.prepareParents(session.path, session.createParents, now, []);
      this.assertCapacity(
        existing?.contentClass === "inline" ? -existing.sizeBytes : 0,
        existing === null ? 1 : 0,
        session.path,
      );
      const insertedObject = this.sql
        .exec<SqlRow>(
          `INSERT INTO vfs_opaque_objects (
           r2_key, size_bytes, etag, r2_version, verified_sha256,
           content_type, retain_until_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         RETURNING id`,
          metadata.key,
          metadata.sizeBytes,
          metadata.etag,
          metadata.version,
          metadata.verifiedSha256 ?? null,
          session.contentType ?? metadata.contentType ?? null,
          now,
        )
        .one();
      const objectId = integerColumn(insertedObject, "id");
      if (existing?.contentClass === "inline") {
        this.sql.exec("DELETE FROM vfs_inline_chunks WHERE entry_id = ?", existing.id);
      }
      const token = this.bumpToken(session.path);
      const parentPath = dirname(session.path);
      const name = basename(session.path);
      const mode = session.mode ?? existing?.mode ?? FILE_MODE;
      const uid = existing?.uid ?? 0;
      const gid = existing?.gid ?? 0;
      const createdAtMs = existing?.createdAtMs ?? now;
      const written = this.sql
        .exec<SqlRow>(
          `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
         ) VALUES (?, ?, ?, ?, 'file', 'opaque', ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'opaque', opaque_object_id = excluded.opaque_object_id,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms,
           revision = vfs_entries.revision + 1
         RETURNING revision`,
          existing?.id ?? null,
          session.path,
          parentPath,
          name,
          objectId,
          metadata.sizeBytes,
          mode,
          uid,
          gid,
          createdAtMs,
          now,
        )
        .one();
      this.updateUsage(
        existing?.contentClass === "inline" ? -existing.sizeBytes : 0,
        existing === null ? 1 : 0,
      );
      if (existing?.contentClass === "opaque" && existing.opaqueObjectId !== null) {
        this.queueObjectIfUnreferenced(existing.opaqueObjectId, now);
      }
      const contentType = session.contentType ?? metadata.contentType;
      const stat: OpaqueFileStat = {
        path: session.path,
        parentPath,
        name,
        kind: "file",
        contentClass: "opaque",
        sizeBytes: metadata.sizeBytes,
        mode,
        uid,
        gid,
        createdAtMs,
        modifiedAtMs: now,
        revision: integerColumn(written, "revision"),
        mutationToken: token,
        ...(contentType === undefined ? {} : { contentType }),
        ...(metadata.verifiedSha256 === undefined
          ? {}
          : { verifiedSha256: metadata.verifiedSha256 }),
      };
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'committed', verification_token = NULL,
           verification_lease_until_ms = NULL, receipt_json = ?, expires_at_ms = ?
         WHERE id = ?`,
        JSON.stringify(stat),
        now + this.receiptRetentionMs,
        uploadId,
      );
      return { stale: false, stat } as const;
    });
    if (committed.stale) {
      await this.scheduleGarbageAlarm();
      emitVfsEvent(this.onEvent, {
        type: "vfs.opaque-upload",
        phase: "reject",
        uploadId,
        objectKey: committed.objectKey,
        path: committed.path,
        reason: "stale-path-token",
      });
      throw new VfsError("EREVISION", "path changed after upload reservation", committed.path);
    }
    await this.scheduleGarbageAlarm();
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "commit",
      uploadId,
      objectKey: started.session.objectKey,
      path: committed.stat.path,
    });
    return committed.stat;
  }

  async abortOpaqueUpload(uploadId: string): Promise<void> {
    let aborted: { path: string; objectKey: string } | undefined;
    this.transaction(() => {
      const session = this.upload(uploadId);
      if (session === null || session.state === "garbage" || session.state === "committed") return;
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ?`,
        uploadId,
      );
      this.queueUploadGarbage(session, this.now());
      aborted = { path: session.path, objectKey: session.objectKey };
    });
    if (aborted === undefined) return;
    await this.scheduleGarbageAlarm();
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "abort",
      uploadId,
      objectKey: aborted.objectKey,
      path: aborted.path,
    });
  }

  resolveOpaqueRead(path: string, leaseMs = DEFAULT_READ_LEASE_MS): OpaqueReadLease {
    validatePositiveInteger(leaseMs, "leaseMs");
    const normalized = this.normalizeAccessPath(path);
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      if (entry.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
      if (entry.contentClass !== "opaque" || entry.opaqueObjectId === null) {
        throw new VfsError("ENOTSUP", "file is not opaque", normalized);
      }
      const object = this.opaqueObject(entry.opaqueObjectId);
      if (object === null)
        throw new VfsError("EIO", "opaque object metadata is missing", normalized);
      const leaseExpiresAtMs = this.now() + Math.min(leaseMs, MAX_READ_LEASE_MS);
      this.sql.exec(
        `UPDATE vfs_opaque_objects
         SET retain_until_ms = MAX(retain_until_ms, ?) WHERE id = ?`,
        leaseExpiresAtMs,
        object.id,
      );
      return {
        stat: rowToStat(entry) as OpaqueFileStat,
        object: metadataFromObject(object),
        leaseExpiresAtMs,
      };
    });
  }

  async drainGarbage(limit = MAX_GC_BATCH): Promise<GarbageDrainResult> {
    validatePositiveInteger(limit, "limit");
    const store = this.opaqueStore;
    const batchLimit = Math.min(limit, MAX_GC_BATCH);
    const now = this.now();
    const expiredSessions: Array<{ uploadId: string; objectKey: string; path: string }> = [];
    const keys = this.transaction(() => {
      const expired = this.sql
        .exec<SqlRow>(
          "SELECT id,path,r2_key,expires_at_ms FROM vfs_upload_sessions WHERE(state='open' AND expires_at_ms<=?)OR(state='verifying' AND verification_lease_until_ms<=?)LIMIT ?",
          now,
          now,
          batchLimit,
        )
        .toArray();
      for (const row of expired) {
        const id = stringColumn(row, "id");
        this.sql.exec(
          "UPDATE vfs_upload_sessions SET state='garbage',verification_token=NULL,verification_lease_until_ms=NULL WHERE id=?",
          id,
        );
        const objectKey = stringColumn(row, "r2_key");
        this.queueGarbage(
          objectKey,
          Math.max(now, integerColumn(row, "expires_at_ms") + this.uploadSettlementGraceMs),
        );
        expiredSessions.push({
          uploadId: id,
          objectKey,
          path: stringColumn(row, "path"),
        });
      }
      this.sql.exec(
        "DELETE FROM vfs_upload_sessions WHERE state = 'committed' AND expires_at_ms <= ?",
        now,
      );
      return this.sql
        .exec<SqlRow>(
          "SELECT r2_key FROM vfs_gc_queue WHERE not_before_ms<=? AND next_attempt_at_ms<=? ORDER BY next_attempt_at_ms,not_before_ms LIMIT ?",
          now,
          now,
          batchLimit,
        )
        .toArray()
        .map((row) => stringColumn(row, "r2_key"));
    });
    for (const session of expiredSessions) {
      emitVfsEvent(this.onEvent, { type: "vfs.opaque-upload", phase: "expire", ...session });
    }
    if (store === undefined || keys.length === 0) {
      await this.scheduleGarbageAlarm();
      const remaining = this.garbageDepth();
      emitVfsEvent(this.onEvent, {
        type: "vfs.garbage",
        deleted: 0,
        remaining,
        failed: 0,
      });
      return { deleted: 0, remaining };
    }
    const selectedKeys = JSON.stringify(keys);
    try {
      await store.delete(keys);
      this.transaction(() => {
        this.sql.exec(
          "DELETE FROM vfs_upload_sessions WHERE state='garbage' AND r2_key IN(SELECT value FROM json_each(?))",
          selectedKeys,
        );
        this.sql.exec(
          "DELETE FROM vfs_gc_queue WHERE r2_key IN (SELECT value FROM json_each(?))",
          selectedKeys,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transaction(() => {
        this.sql.exec(
          "UPDATE vfs_gc_queue SET attempts=attempts+1,next_attempt_at_ms=?+MIN((1<<MIN(attempts+1,12))*1000,60*60*1000),last_error=? WHERE r2_key IN(SELECT value FROM json_each(?))",
          now,
          message,
          selectedKeys,
        );
      });
      await this.scheduleGarbageAlarm();
      emitVfsEvent(this.onEvent, {
        type: "vfs.garbage",
        deleted: 0,
        remaining: this.garbageDepth(),
        failed: keys.length,
      });
      throw error;
    }
    await this.scheduleGarbageAlarm();
    const remaining = this.garbageDepth();
    emitVfsEvent(this.onEvent, {
      type: "vfs.garbage",
      deleted: keys.length,
      remaining,
      failed: 0,
    });
    return { deleted: keys.length, remaining };
  }

  private garbageDepth(): number {
    return integerColumn(
      this.sql.exec<SqlRow>("SELECT COUNT(*) AS value FROM vfs_gc_queue").one(),
      "value",
    );
  }
}

/**
 * Immutable per-execution view. Access checks are implemented by the shared
 * SQL engine so the decision and a synchronous mutation stay in one turn; the
 * wrapper carries only credentials and cannot be retargeted after creation.
 */
class PosixFileSystemView implements VirtualFileSystem {
  constructor(
    private readonly inner: SqlFileSystem,
    private readonly access: PosixAccessContext,
  ) {}

  getMutationToken(path: string, options?: MutationTokenOptions): string {
    return this.inner.getMutationToken(path, options, this.access);
  }

  stat(path: string): VfsStat {
    return this.inner.stat(path, this.access);
  }

  lstat(path: string): VfsStat {
    return this.inner.lstat(path, this.access);
  }

  readlink(path: string): string {
    return this.inner.readlink(path, this.access);
  }

  symlink(path: string, target: string, options?: SymlinkOptions): VfsStat {
    return this.inner.symlink(path, target, options, this.access);
  }

  realpath(path: string, options?: { follow?: boolean }): string {
    return this.inner.realpath(path, options, this.access);
  }

  list(path: string): VfsStat[] {
    return this.inner.list(path, this.access);
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    return this.inner.listPage(path, options, this.access);
  }

  find(options: FindOptions): VfsStat[] {
    return this.inner.find(options, this.access);
  }

  findPage(options: FindOptions): EntryPage {
    return this.inner.findPage(options, this.access);
  }

  countSubtree(path: string): number {
    return this.inner.countSubtree(path, this.access);
  }

  mutationSubtreeCount(path: string, operation: PosixMutationOperation): number {
    return this.inner.countPosixMutationSubtree(path, operation, this.access);
  }

  readFile(path: string): InlineReadResult {
    return this.inner.readFile(path, this.access);
  }

  writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    return this.inner.writeFile(path, body, options, this.access);
  }

  appendFile(path: string, body: ByteBody, options?: AppendFileOptions): Promise<WriteResult> {
    return this.inner.appendFile(path, body, options, this.access);
  }

  touch(path: string, options?: TouchOptions): VfsStat {
    return this.inner.touch(path, options, this.access);
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    return this.inner.setMetadata(path, options, this.access);
  }

  setOwnership(path: string, options: OwnershipUpdateOptions): VfsStat {
    return this.inner.setOwnership(path, options, this.access);
  }

  mkdir(path: string, recursive?: boolean, mode?: number): VfsStat {
    return this.inner.mkdir(path, recursive, mode, this.access);
  }

  remove(path: string, options?: RemoveOptions): Promise<RemoveResult> {
    return this.inner.remove(path, options, this.access);
  }

  move(from: string, to: string, options?: MoveOptions): Promise<MoveResult> {
    return this.inner.move(from, to, options, this.access);
  }

  copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult> {
    return this.inner.copy(from, to, options, this.access);
  }

  beginOpaqueUpload(): Promise<OpaqueUploadReservation> {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer opaque uploads"));
  }

  commitOpaqueUpload(): Promise<OpaqueFileStat> {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer opaque uploads"));
  }

  abortOpaqueUpload(): Promise<void> {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer opaque uploads"));
  }

  resolveOpaqueRead(path: string, leaseMs?: number): OpaqueReadLease {
    const stat = this.inner.stat(path, this.access);
    if (stat.kind !== "file") throw new VfsError("EISDIR", "is a directory", path);
    if (
      this.access.credentials.uid !== 0 &&
      (posixPermissions(stat, this.access) & READ_PERMISSION) === 0
    ) {
      throw new VfsError("EACCES", "permission denied", path);
    }
    return this.inner.resolveOpaqueRead(path, leaseMs);
  }

  drainGarbage(): Promise<GarbageDrainResult> {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer garbage collection"));
  }
}
