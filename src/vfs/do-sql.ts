import { VfsError } from "../core/errors.js";
import { matchesGlob } from "../core/glob.js";
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
  DEFAULT_READ_LEASE_MS,
  DEFAULT_UPLOAD_TTL_MS,
  DEFAULT_VERIFY_LEASE_MS,
  DIRECTORY_MODE,
  FILE_MODE,
  MAX_READ_LEASE_MS,
  NEVER_MUTATED_TOKEN,
  resolveFileSystemLimits,
  type CommonFileSystemOptions,
  validatePositiveInteger,
} from "./config.js";
import { rechunk, streamFromChunks } from "./streams.js";
import {
  type AppendFileOptions,
  type BeginOpaqueUploadOptions,
  type ByteBody,
  type CommitOpaqueUploadOptions,
  type CopyOptions,
  type CopyResult,
  type EntryPage,
  type FindOptions,
  type GarbageDrainResult,
  type InlineFileStat,
  type InlineReadResult,
  type MetadataUpdateOptions,
  type MoveOptions,
  type MoveResult,
  type OpaqueFileStat,
  type OpaqueObjectMetadata,
  type OpaqueReadLease,
  type OpaqueStore,
  type OpaqueUploadReservation,
  type PageOptions,
  type RemoveOptions,
  type RemoveResult,
  type TouchOptions,
  type VfsStat,
  type VirtualFileSystem,
  type WriteFileOptions,
  type WriteResult,
} from "./types.js";

const DEFAULT_MAX_DATABASE_BYTES = 10_000_000_000;
const DEFAULT_DATABASE_HEADROOM_BYTES = 64 * 1024 * 1024;
const MAX_GC_BATCH = 100;

const ENTRY_COLUMNS = `
  e.id, e.path, e.parent_path, e.name, e.kind, e.content_class,
  e.opaque_object_id, e.size_bytes, e.mode, e.created_at_ms,
  e.modified_at_ms, e.revision, p.mutation_token
`;

type SqlRow = Readonly<Record<string, SqlStorageValue>>;

interface EntryRow {
  id: string;
  path: string;
  parentPath: string;
  name: string;
  kind: "directory" | "file";
  contentClass: "inline" | "opaque" | null;
  opaqueObjectId: string | null;
  sizeBytes: number;
  mode: number;
  createdAtMs: number;
  modifiedAtMs: number;
  revision: number;
  mutationToken: string;
}

interface OpaqueObjectRow {
  id: string;
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

export interface DurableObjectFileSystemOptions extends CommonFileSystemOptions {
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

function parseEntry(row: SqlRow): EntryRow {
  const kind = stringColumn(row, "kind");
  const contentClass = nullableStringColumn(row, "content_class");
  const opaqueObjectId = nullableStringColumn(row, "opaque_object_id");
  if (kind !== "directory" && kind !== "file") invalidColumn("kind", "directory or file");
  if (contentClass !== null && contentClass !== "inline" && contentClass !== "opaque") {
    invalidColumn("content_class", "inline, opaque, or null");
  }
  if (
    (kind === "directory" && (contentClass !== null || opaqueObjectId !== null))
    || (kind === "file" && contentClass === null)
    || (contentClass === "inline" && opaqueObjectId !== null)
    || (contentClass === "opaque" && opaqueObjectId === null)
  ) {
    throw new VfsError("EIO", "invalid SQLite entry state", stringColumn(row, "path"));
  }
  return {
    id: stringColumn(row, "id"),
    path: stringColumn(row, "path"),
    parentPath: stringColumn(row, "parent_path"),
    name: stringColumn(row, "name"),
    kind,
    contentClass,
    opaqueObjectId,
    sizeBytes: integerColumn(row, "size_bytes"),
    mode: integerColumn(row, "mode"),
    createdAtMs: integerColumn(row, "created_at_ms"),
    modifiedAtMs: integerColumn(row, "modified_at_ms"),
    revision: integerColumn(row, "revision"),
    mutationToken: stringColumn(row, "mutation_token"),
  };
}

function rowToStat(row: EntryRow): VfsStat {
  const common = {
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    sizeBytes: row.sizeBytes,
    mode: row.mode,
    createdAtMs: row.createdAtMs,
    modifiedAtMs: row.modifiedAtMs,
    revision: row.revision,
    mutationToken: row.mutationToken,
  };
  if (row.kind === "directory") return { ...common, kind: "directory", contentClass: null };
  if (row.contentClass === "inline") return { ...common, kind: "file", contentClass: "inline" };
  if (row.contentClass === "opaque") return { ...common, kind: "file", contentClass: "opaque" };
  throw new VfsError("EIO", "invalid SQLite entry state", row.path);
}

function parseOpaqueObject(row: SqlRow): OpaqueObjectRow {
  return {
    id: stringColumn(row, "id"),
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

export class DurableObjectFileSystem implements VirtualFileSystem {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
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

  constructor(storage: DurableObjectStorage, options: DurableObjectFileSystemOptions = {}) {
    const limits = resolveFileSystemLimits(options);
    this.storage = storage;
    this.sql = storage.sql;
    this.chunkBytes = limits.chunkBytes;
    this.maxInlineFileBytes = limits.maxInlineFileBytes;
    this.maxInlineLogicalBytes = limits.maxInlineLogicalBytes;
    this.maxEntries = limits.maxEntries;
    this.inFlightBytes = new InFlightByteBudget(limits.maxInFlightBufferedBytes);
    this.maxDatabaseBytes = options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES;
    this.minDatabaseHeadroomBytes = options.minDatabaseHeadroomBytes
      ?? DEFAULT_DATABASE_HEADROOM_BYTES;
    this.uploadSettlementGraceMs = limits.uploadSettlementGraceMs;
    this.receiptRetentionMs = limits.receiptRetentionMs;
    this.opaqueStore = options.opaqueStore;
    this.clock = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.workspaceId = options.workspaceId ?? "workspace";

    for (const [name, value] of [
      ["maxDatabaseBytes", this.maxDatabaseBytes],
      ["minDatabaseHeadroomBytes", this.minDatabaseHeadroomBytes],
    ] as const) validatePositiveInteger(value, name);
    this.migrate();
  }

  private now(): number {
    return this.clock();
  }

  private newToken(): string {
    return this.createId();
  }

  private transaction<T>(callback: () => T): T {
    try {
      return this.storage.transactionSync(callback);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (/SQLITE_FULL|database or disk is full/iu.test(message)) {
        throw new VfsError("ENOSPC", "SQLite database capacity is exhausted");
      }
      throw error;
    }
  }

  private migrate(): void {
    this.transaction(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS vfs2_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vfs2_path_versions (
          path TEXT PRIMARY KEY,
          mutation_token TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1)
        );
        CREATE TABLE IF NOT EXISTS vfs2_opaque_objects (
          id TEXT PRIMARY KEY,
          r2_key TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          etag TEXT NOT NULL,
          r2_version TEXT NOT NULL,
          verified_sha256 TEXT,
          content_type TEXT,
          retain_until_ms INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vfs2_entries (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          parent_path TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
          content_class TEXT CHECK (content_class IN ('inline', 'opaque')),
          opaque_object_id TEXT,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          mode INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          modified_at_ms INTEGER NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          CHECK (
            (kind = 'directory' AND content_class IS NULL AND opaque_object_id IS NULL)
            OR (kind = 'file' AND content_class = 'inline' AND opaque_object_id IS NULL)
            OR (kind = 'file' AND content_class = 'opaque' AND opaque_object_id IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS vfs2_entries_parent_name
          ON vfs2_entries(parent_path, name);
        CREATE INDEX IF NOT EXISTS vfs2_entries_kind_path
          ON vfs2_entries(kind, path);
        CREATE INDEX IF NOT EXISTS vfs2_entries_opaque_object
          ON vfs2_entries(opaque_object_id) WHERE opaque_object_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS vfs2_inline_chunks (
          entry_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          body BLOB NOT NULL,
          PRIMARY KEY (entry_id, chunk_index)
        );
        CREATE TABLE IF NOT EXISTS vfs2_upload_sessions (
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
        );
        CREATE INDEX IF NOT EXISTS vfs2_upload_expiry
          ON vfs2_upload_sessions(state, expires_at_ms);
        CREATE TABLE IF NOT EXISTS vfs2_gc_queue (
          r2_key TEXT PRIMARY KEY,
          not_before_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER NOT NULL,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS vfs2_gc_due
          ON vfs2_gc_queue(next_attempt_at_ms, not_before_ms);
        CREATE TABLE IF NOT EXISTS vfs2_usage (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          inline_bytes INTEGER NOT NULL CHECK (inline_bytes >= 0),
          entries INTEGER NOT NULL CHECK (entries >= 1)
        );
        CREATE TRIGGER IF NOT EXISTS vfs2_opaque_entry_insert_guard
          BEFORE INSERT ON vfs2_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs2_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER IF NOT EXISTS vfs2_opaque_entry_update_guard
          BEFORE UPDATE OF content_class, opaque_object_id ON vfs2_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs2_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER IF NOT EXISTS vfs2_opaque_object_delete_guard
          BEFORE DELETE ON vfs2_opaque_objects
          WHEN EXISTS (
            SELECT 1 FROM vfs2_entries WHERE opaque_object_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object is still referenced'); END;
        CREATE TRIGGER IF NOT EXISTS vfs2_inline_chunk_insert_guard
          BEFORE INSERT ON vfs2_inline_chunks
          WHEN NOT EXISTS (
            SELECT 1 FROM vfs2_entries
            WHERE id = NEW.entry_id AND content_class = 'inline'
          )
          BEGIN SELECT RAISE(ABORT, 'inline chunk has no inline entry'); END;
        CREATE TRIGGER IF NOT EXISTS vfs2_inline_entry_delete_guard
          BEFORE DELETE ON vfs2_entries
          WHEN EXISTS (
            SELECT 1 FROM vfs2_inline_chunks WHERE entry_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;
        CREATE TRIGGER IF NOT EXISTS vfs2_inline_entry_update_guard
          BEFORE UPDATE OF content_class ON vfs2_entries
          WHEN OLD.content_class = 'inline' AND NEW.content_class <> 'inline'
            AND EXISTS (
              SELECT 1 FROM vfs2_inline_chunks WHERE entry_id = OLD.id
            )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;
      `);
      const now = this.now();
      const rootToken = this.newToken();
      this.sql.exec(
        `INSERT OR IGNORE INTO vfs2_path_versions (path, mutation_token, version)
         VALUES ('/', ?, 1)`,
        rootToken,
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO vfs2_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, created_at_ms, modified_at_ms, revision
         ) VALUES (?, '/', '/', '/', 'directory', NULL, NULL, 0, ?, 0, 0, 1)`,
        this.createId(),
        DIRECTORY_MODE,
      );
      this.sql.exec(
        "INSERT OR IGNORE INTO vfs2_usage (singleton, inline_bytes, entries) VALUES (1, 0, 1)",
      );
      this.sql.exec(
        "INSERT OR IGNORE INTO vfs2_schema_migrations (version, applied_at_ms) VALUES (1, ?)",
        now,
      );
    });
  }

  private rows(query: string, ...bindings: SqlStorageValue[]): EntryRow[] {
    return this.sql.exec<SqlRow>(query, ...bindings).toArray().map(parseEntry);
  }

  private oneEntry(path: string): EntryRow | null {
    return this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs2_entries e
       JOIN vfs2_path_versions p ON p.path = e.path
       WHERE e.path = ?`,
      path,
    )[0] ?? null;
  }

  private requireEntry(path: string): EntryRow {
    const row = this.oneEntry(path);
    if (row === null) throw new VfsError("ENOENT", "no such file or directory", path);
    return row;
  }

  private requireDirectory(path: string): EntryRow {
    const row = this.requireEntry(path);
    if (row.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", path);
    return row;
  }

  private requireInline(path: string): EntryRow {
    const row = this.requireEntry(path);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (row.contentClass !== "inline") {
      throw new VfsError(
        "ENOTSUP",
        "opaque R2 content is not available to shell commands",
        path,
      );
    }
    return row;
  }

  private normalizeAccessPath(path: string, allowMissingDirectory = false): string {
    const normalized = normalizePath(path);
    if (!pathRequiresDirectory(path) || normalized === "/") return normalized;
    const entry = this.oneEntry(normalized);
    if (entry === null) {
      if (allowMissingDirectory) return normalized;
      throw new VfsError("ENOENT", "no such directory", normalized);
    }
    if (entry.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", normalized);
    return normalized;
  }

  private tokenFor(path: string): string {
    const current = this.sql.exec<SqlRow>(
      "SELECT mutation_token FROM vfs2_path_versions WHERE path = ?",
      path,
    ).toArray()[0];
    if (current !== undefined) return stringColumn(current, "mutation_token");
    return NEVER_MUTATED_TOKEN;
  }

  private bumpToken(path: string): string {
    const token = this.newToken();
    this.sql.exec(
      `INSERT INTO vfs2_path_versions (path, mutation_token, version)
       VALUES (?, ?, 1)
       ON CONFLICT(path) DO UPDATE SET
         mutation_token = excluded.mutation_token,
         version = vfs2_path_versions.version + 1`,
      path,
      token,
    );
    return token;
  }

  private validateGuard(
    path: string,
    entry: EntryRow | null,
    guard: { ifRevision?: number; ifMutationToken?: string },
  ): void {
    if (guard.ifRevision !== undefined && entry?.revision !== guard.ifRevision) {
      throw new VfsError("EREVISION", "file revision does not match", path);
    }
    if (guard.ifMutationToken !== undefined && this.tokenFor(path) !== guard.ifMutationToken) {
      throw new VfsError("EREVISION", "path mutation token does not match", path);
    }
  }

  private usage(): { inlineBytes: number; entries: number } {
    const row = this.sql.exec<SqlRow>(
      "SELECT inline_bytes, entries FROM vfs2_usage WHERE singleton = 1",
    ).one();
    return {
      inlineBytes: integerColumn(row, "inline_bytes"),
      entries: integerColumn(row, "entries"),
    };
  }

  private updateUsage(inlineDelta: number, entryDelta: number): void {
    this.sql.exec(
      `UPDATE vfs2_usage SET
         inline_bytes = inline_bytes + ?, entries = entries + ?
       WHERE singleton = 1`,
      inlineDelta,
      entryDelta,
    );
  }

  private assertCapacity(inlineDelta: number, entryDelta: number, path?: string): void {
    const usage = this.usage();
    if (usage.inlineBytes + inlineDelta > this.maxInlineLogicalBytes) {
      throw new VfsError("ENOSPC", "workspace inline-byte quota exceeded", path);
    }
    if (usage.entries + entryDelta > this.maxEntries) {
      throw new VfsError("ENOSPC", "filesystem entry quota exceeded", path);
    }
    if (this.sql.databaseSize + this.minDatabaseHeadroomBytes > this.maxDatabaseBytes) {
      throw new VfsError("ENOSPC", "SQLite database headroom is exhausted", path);
    }
  }

  private createDirectory(path: string, now: number, mode = DIRECTORY_MODE): EntryRow {
    const token = this.bumpToken(path);
    const id = this.createId();
    this.sql.exec(
      `INSERT INTO vfs2_entries (
         id, path, parent_path, name, kind, content_class, opaque_object_id,
         size_bytes, mode, created_at_ms, modified_at_ms, revision
       ) VALUES (?, ?, ?, ?, 'directory', NULL, NULL, 0, ?, ?, ?, 1)`,
      id,
      path,
      dirname(path),
      basename(path),
      mode,
      now,
      now,
    );
    this.updateUsage(0, 1);
    return {
      id,
      path,
      parentPath: dirname(path),
      name: basename(path),
      kind: "directory",
      contentClass: null,
      opaqueObjectId: null,
      sizeBytes: 0,
      mode,
      createdAtMs: now,
      modifiedAtMs: now,
      revision: 1,
      mutationToken: token,
    };
  }

  private ensureParents(path: string, recursive: boolean, now: number): void {
    const missing: string[] = [];
    let current = dirname(path);
    while (this.oneEntry(current) === null) {
      missing.unshift(current);
      current = dirname(current);
    }
    this.requireDirectory(current);
    if (missing.length > 0 && !recursive) {
      throw new VfsError("ENOENT", "parent directory does not exist", dirname(path));
    }
    this.assertCapacity(0, missing.length, path);
    for (const parent of missing) this.createDirectory(parent, now);
  }

  private collectInline(body: ByteBody) {
    return collectInlineBytes(
      body,
      this.maxInlineFileBytes,
      this.chunkBytes,
      this.inFlightBytes,
    );
  }

  private useBuffered<T>(
    buffered: { chunks: Uint8Array[]; release(): void },
    operation: (chunks: Uint8Array[]) => T,
  ): T {
    try {
      return operation(buffered.chunks);
    } finally {
      buffered.release();
    }
  }

  stat(path: string): VfsStat {
    const row = this.requireEntry(this.normalizeAccessPath(path));
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

  getMutationToken(path: string): string {
    return this.transaction(() => this.tokenFor(normalizePath(path)));
  }

  list(path: string): VfsStat[] {
    const normalized = this.normalizeAccessPath(path);
    this.requireDirectory(normalized);
    return this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs2_entries e
       JOIN vfs2_path_versions p ON p.path = e.path
       WHERE e.parent_path = ? AND e.path <> '/'
       ORDER BY e.name`,
      normalized,
    ).map(rowToStat);
  }

  listPage(path: string, options: PageOptions = {}): EntryPage {
    const normalized = this.normalizeAccessPath(path);
    this.requireDirectory(normalized);
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    const rows = this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs2_entries e
       JOIN vfs2_path_versions p ON p.path = e.path
       WHERE e.parent_path = ? AND e.path <> '/' AND e.path > ?
       ORDER BY e.path LIMIT ?`,
      normalized,
      options.cursor ?? "",
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map(rowToStat),
      nextCursor: rows.length > limit ? page.at(-1)?.path ?? null : null,
      scanned: page.length,
    };
  }

  find(options: FindOptions): VfsStat[] {
    const maximum = options.limit ?? 10_000;
    const result: VfsStat[] = [];
    let cursor = options.cursor;
    do {
      const page = this.findPage({
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(maximum - result.length, 1000),
      });
      result.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && result.length < maximum);
    return result;
  }

  findPage(options: FindOptions): EntryPage {
    const root = this.normalizeAccessPath(options.path);
    const rootEntry = this.requireEntry(root);
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    const range = descendantRange(root);
    const cursor = options.cursor ?? (root === "/" ? "" : root);
    const includeRoot = options.cursor === undefined
      && (rootEntry.kind === "file" || (options.includeRoot ?? false));
    const descendants = rootEntry.kind === "file" ? [] : this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs2_entries e
       JOIN vfs2_path_versions p ON p.path = e.path
       WHERE e.path >= ? AND e.path < ? AND e.path > ? AND e.path <> ?
       ORDER BY e.path LIMIT ?`,
      range.lower,
      range.upper,
      cursor,
      root,
      limit + (includeRoot ? 0 : 1),
    );
    const scannedRows = (includeRoot ? [rootEntry, ...descendants] : descendants).slice(0, limit);
    const entries = scannedRows.filter((row) => {
      if (options.maxDepth !== undefined && depthFrom(root, row.path) > options.maxDepth) return false;
      if (options.type !== undefined && row.kind !== options.type) return false;
      if (options.name !== undefined && !matchesGlob(row.name, options.name)) return false;
      if (options.pathGlob !== undefined && !matchesGlob(row.path, options.pathGlob)) return false;
      return true;
    }).map(rowToStat);
    const hasMore = descendants.length + (includeRoot ? 1 : 0) > limit;
    return {
      entries,
      nextCursor: hasMore ? scannedRows.at(-1)?.path ?? null : null,
      scanned: scannedRows.length,
    };
  }

  readFile(path: string): InlineReadResult {
    const normalized = this.normalizeAccessPath(path);
    const entry = this.requireInline(normalized);
    const chunks = this.sql.exec<SqlRow>(
      `SELECT body FROM vfs2_inline_chunks
       WHERE entry_id = ? ORDER BY chunk_index`,
      entry.id,
    ).toArray().map((row) => new Uint8Array(blobColumn(row, "body")).slice());
    const sizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    this.inFlightBytes.acquire(sizeBytes);
    return {
      stat: rowToStat(entry) as InlineFileStat,
      stream: streamFromChunks(chunks, () => {
        this.inFlightBytes.release(sizeBytes);
      }),
    };
  }

  private opaqueObject(id: string): OpaqueObjectRow | null {
    const row = this.sql.exec<SqlRow>(
      `SELECT id, r2_key, size_bytes, etag, r2_version, verified_sha256,
              content_type, retain_until_ms
       FROM vfs2_opaque_objects WHERE id = ?`,
      id,
    ).toArray()[0];
    return row === undefined ? null : parseOpaqueObject(row);
  }

  private upload(id: string): UploadRow | null {
    const row = this.sql.exec<SqlRow>(
      `SELECT id, path, expected_mutation_token, r2_key, state,
              verification_token, expected_size_bytes, expires_at_ms,
              verification_lease_until_ms, create_parents, mode,
              content_type, receipt_json
       FROM vfs2_upload_sessions WHERE id = ?`,
      id,
    ).toArray()[0];
    return row === undefined ? null : parseUpload(row);
  }

  private queueGarbage(objectKey: string, notBeforeMs: number): void {
    this.sql.exec(
      `INSERT INTO vfs2_gc_queue (
         r2_key, not_before_ms, attempts, next_attempt_at_ms, last_error
       ) VALUES (?, ?, 0, ?, NULL)
       ON CONFLICT(r2_key) DO UPDATE SET
         not_before_ms = MAX(vfs2_gc_queue.not_before_ms, excluded.not_before_ms),
         next_attempt_at_ms = MAX(vfs2_gc_queue.next_attempt_at_ms, excluded.not_before_ms)`,
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

  private queueObjectIfUnreferenced(objectId: string, now: number): boolean {
    const referenced = this.sql.exec<SqlRow>(
      "SELECT 1 AS present FROM vfs2_entries WHERE opaque_object_id = ? LIMIT 1",
      objectId,
    ).toArray()[0];
    if (referenced !== undefined) return false;
    const object = this.opaqueObject(objectId);
    if (object === null) return false;
    this.sql.exec("DELETE FROM vfs2_opaque_objects WHERE id = ?", objectId);
    this.queueGarbage(object.key, Math.max(now, object.retainUntilMs));
    return true;
  }

  private removeExact(path: string, now: number): number {
    const entry = this.oneEntry(path);
    if (entry === null) return 0;
    if (entry.contentClass === "inline") {
      this.sql.exec("DELETE FROM vfs2_inline_chunks WHERE entry_id = ?", entry.id);
    }
    this.sql.exec("DELETE FROM vfs2_entries WHERE id = ?", entry.id);
    this.bumpToken(path);
    this.updateUsage(entry.contentClass === "inline" ? -entry.sizeBytes : 0, -1);
    if (
      entry.contentClass === "opaque"
      && entry.opaqueObjectId !== null
      && this.queueObjectIfUnreferenced(entry.opaqueObjectId, now)
    ) return 1;
    return 0;
  }

  private async scheduleGarbageAlarm(): Promise<void> {
    const row = this.sql.exec<SqlRow>(
      `SELECT MIN(due) AS due FROM (
         SELECT MAX(not_before_ms, next_attempt_at_ms) AS due FROM vfs2_gc_queue
         UNION ALL
         SELECT expires_at_ms AS due FROM vfs2_upload_sessions WHERE state = 'open'
         UNION ALL
         SELECT verification_lease_until_ms AS due
         FROM vfs2_upload_sessions WHERE state = 'verifying'
         UNION ALL
         SELECT expires_at_ms AS due FROM vfs2_upload_sessions WHERE state = 'committed'
       )`,
    ).one();
    const due = nullableIntegerColumn(row, "due");
    if (due === null) {
      if (await this.storage.getAlarm() !== null) await this.storage.deleteAlarm();
      return;
    }
    const current = await this.storage.getAlarm();
    if (current !== due) await this.storage.setAlarm(due);
  }

  async writeFile(
    path: string,
    body: ByteBody,
    options: WriteFileOptions = {},
  ): Promise<WriteResult> {
    const normalized = this.normalizeAccessPath(path, true);
    const before = this.oneEntry(normalized);
    const disposition = options.disposition ?? "upsert";
    if (disposition === "create" && before !== null) {
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    if (disposition === "replace" && before === null) {
      throw new VfsError("ENOENT", "no such file", normalized);
    }
    if (before?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    this.validateGuard(normalized, before, options);
    const capturedToken = this.tokenFor(normalized);
    const buffered = await this.collectInline(body);

    let queued = false;
    const result = this.useBuffered(buffered, (chunks) => this.transaction(() => {
      const sizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const current = this.oneEntry(normalized);
      if (this.tokenFor(normalized) !== capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", normalized);
      }
      this.validateGuard(normalized, current, options);
      if (current?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
      const previousInlineBytes = current?.contentClass === "inline" ? current.sizeBytes : 0;
      const inlineDelta = sizeBytes - previousInlineBytes;
      const now = this.now();
      this.ensureParents(normalized, options.createParents ?? false, now);
      this.assertCapacity(inlineDelta, current === null ? 1 : 0, normalized);
      const token = this.bumpToken(normalized);
      const id = current?.id ?? this.createId();
      if (current?.contentClass === "inline") {
        this.sql.exec("DELETE FROM vfs2_inline_chunks WHERE entry_id = ?", id);
      }
      this.sql.exec(
        `INSERT INTO vfs2_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, created_at_ms, modified_at_ms, revision
         ) VALUES (?, ?, ?, ?, 'file', 'inline', NULL, ?, ?, ?, ?, 1)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'inline', opaque_object_id = NULL,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms,
           revision = vfs2_entries.revision + 1`,
        id,
        normalized,
        dirname(normalized),
        basename(normalized),
        sizeBytes,
        options.mode ?? current?.mode ?? FILE_MODE,
        current?.createdAtMs ?? now,
        now,
      );
      for (const [index, chunk] of chunks.entries()) {
        this.sql.exec(
          "INSERT INTO vfs2_inline_chunks (entry_id, chunk_index, body) VALUES (?, ?, ?)",
          id,
          index,
          chunk,
        );
      }
      this.updateUsage(inlineDelta, current === null ? 1 : 0);
      if (
        current?.contentClass === "opaque"
        && current.opaqueObjectId !== null
        && this.queueObjectIfUnreferenced(current.opaqueObjectId, now)
      ) queued = true;
      const row = this.requireEntry(normalized);
      return {
        path: normalized,
        revision: row.revision,
        mutationToken: token,
        sizeBytes,
        created: current === null,
      };
    }));
    if (queued) await this.scheduleGarbageAlarm();
    return result;
  }

  async appendFile(
    path: string,
    body: ByteBody,
    options: AppendFileOptions = {},
  ): Promise<WriteResult> {
    const normalized = this.normalizeAccessPath(path);
    const before = this.requireInline(normalized);
    this.validateGuard(normalized, before, options);
    const capturedToken = before.mutationToken;
    const buffered = await this.collectInline(body);
    return this.useBuffered(buffered, (suffixChunks) => {
      const suffixBytes = suffixChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      return this.transaction(() => {
      const current = this.requireInline(normalized);
      if (current.mutationToken !== capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", normalized);
      }
      this.validateGuard(normalized, current, options);
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
        throw new VfsError(
          "EFBIG",
          `inline content exceeds the ${this.maxInlineFileBytes}-byte limit`,
          normalized,
        );
      }
      this.assertCapacity(suffixBytes, 0, normalized);
      const oldChunks = this.sql.exec<SqlRow>(
        "SELECT body FROM vfs2_inline_chunks WHERE entry_id = ? ORDER BY chunk_index",
        current.id,
      ).toArray().map((row) => new Uint8Array(blobColumn(row, "body")));
      const chunks = rechunk([...oldChunks, ...suffixChunks], this.chunkBytes);
      this.sql.exec("DELETE FROM vfs2_inline_chunks WHERE entry_id = ?", current.id);
      for (const [index, chunk] of chunks.entries()) {
        this.sql.exec(
          "INSERT INTO vfs2_inline_chunks (entry_id, chunk_index, body) VALUES (?, ?, ?)",
          current.id,
          index,
          chunk,
        );
      }
      const now = this.now();
      const token = this.bumpToken(normalized);
      this.sql.exec(
        `UPDATE vfs2_entries SET size_bytes = ?, modified_at_ms = ?, revision = revision + 1
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

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    const normalized = this.normalizeAccessPath(path);
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      this.validateGuard(normalized, entry, options);
      const token = this.bumpToken(normalized);
      const modifiedAtMs = options.modifiedAtMs ?? this.now();
      this.sql.exec(
        `UPDATE vfs2_entries SET mode = ?, modified_at_ms = ?, revision = revision + 1
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

  touch(path: string, options: TouchOptions = {}): VfsStat {
    const normalized = this.normalizeAccessPath(path, true);
    const existing = this.oneEntry(normalized);
    if (existing !== null) return this.setMetadata(normalized, options);
    if (options.create === false) {
      throw new VfsError("ENOENT", "no such file or directory", normalized);
    }
    return this.transaction(() => {
      this.validateGuard(normalized, null, options);
      const now = this.now();
      this.ensureParents(normalized, options.createParents ?? false, now);
      this.assertCapacity(0, 1, normalized);
      const token = this.bumpToken(normalized);
      const id = this.createId();
      this.sql.exec(
        `INSERT INTO vfs2_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, created_at_ms, modified_at_ms, revision
         ) VALUES (?, ?, ?, ?, 'file', 'inline', NULL, 0, ?, ?, ?, 1)`,
        id,
        normalized,
        dirname(normalized),
        basename(normalized),
        options.mode ?? FILE_MODE,
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
        mode: options.mode ?? FILE_MODE,
        createdAtMs: now,
        modifiedAtMs: options.modifiedAtMs ?? now,
        revision: 1,
        mutationToken: token,
      };
    });
  }

  mkdir(path: string, recursive = false, mode = DIRECTORY_MODE): VfsStat {
    const normalized = this.normalizeAccessPath(path, true);
    return this.transaction(() => {
      const existing = this.oneEntry(normalized);
      if (existing !== null) {
        if (recursive && existing.kind === "directory") return rowToStat(existing);
        throw new VfsError("EEXIST", "file or directory already exists", normalized);
      }
      const now = this.now();
      this.ensureParents(normalized, recursive, now);
      this.assertCapacity(0, 1, normalized);
      return rowToStat(this.createDirectory(normalized, now, mode));
    });
  }

  async remove(path: string, options: RemoveOptions = {}): Promise<RemoveResult> {
    const normalized = this.normalizeAccessPath(path);
    if (normalized === "/") throw new VfsError("EINVAL", "cannot remove root", normalized);
    let queued = 0;
    const result = this.transaction(() => {
      const root = this.requireEntry(normalized);
      const range = descendantRange(normalized);
      const descendants = this.rows(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs2_entries e
         JOIN vfs2_path_versions p ON p.path = e.path
         WHERE e.path >= ? AND e.path < ? AND e.path <> ?
         ORDER BY LENGTH(e.path) DESC`,
        range.lower,
        range.upper,
        normalized,
      );
      if (root.kind === "directory" && descendants.length > 0 && !(options.recursive ?? false)) {
        throw new VfsError("ENOTEMPTY", "directory is not empty", normalized);
      }
      const now = this.now();
      for (const row of descendants) queued += this.removeExact(row.path, now);
      queued += this.removeExact(normalized, now);
      return {
        removed: descendants.length + 1,
        opaqueObjectsQueuedForDeletion: queued,
      };
    });
    if (queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }

  async move(from: string, to: string, options: MoveOptions = {}): Promise<MoveResult> {
    const source = this.normalizeAccessPath(from);
    const target = this.normalizeAccessPath(to, true);
    if (source === "/") throw new VfsError("EINVAL", "cannot move root", source);
    if (source === target) return { from: source, to: target, moved: 1, replaced: false };
    if (isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory into itself", target);
    }
    let queued = 0;
    const result = this.transaction(() => {
      const sourceEntry = this.requireEntry(source);
      this.requireDirectory(dirname(target));
      const destination = this.oneEntry(target);
      if (destination !== null && !(options.replace ?? false)) {
        throw new VfsError("EEXIST", "destination exists", target);
      }
      if (destination !== null && destination.kind === "directory") {
        const children = this.sql.exec<SqlRow>(
          "SELECT 1 AS present FROM vfs2_entries WHERE parent_path = ? LIMIT 1",
          target,
        ).toArray()[0];
        if (children !== undefined) throw new VfsError("ENOTEMPTY", "directory is not empty", target);
      }
      if (destination !== null && destination.kind !== sourceEntry.kind) {
        throw new VfsError(
          destination.kind === "directory" ? "EISDIR" : "ENOTDIR",
          "source and destination kinds differ",
          target,
        );
      }
      const sourceRange = descendantRange(source);
      const moving = this.rows(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs2_entries e
         JOIN vfs2_path_versions p ON p.path = e.path
         WHERE e.path = ? OR (e.path >= ? AND e.path < ?)
         ORDER BY LENGTH(e.path)`,
        source,
        sourceRange.lower,
        sourceRange.upper,
      );
      const now = this.now();
      if (destination !== null) queued += this.removeExact(target, now);
      for (const row of moving) {
        const newPath = `${target}${row.path.slice(source.length)}`;
        const token = this.bumpToken(newPath);
        this.bumpToken(row.path);
        this.sql.exec(
          `UPDATE vfs2_entries SET
             path = ?, parent_path = ?, name = ?, modified_at_ms = ?, revision = revision + 1
           WHERE id = ?`,
          newPath,
          dirname(newPath),
          basename(newPath),
          row.path === source ? now : row.modifiedAtMs,
          row.id,
        );
        if (token.length === 0) throw new VfsError("EIO", "failed to allocate path token");
      }
      return {
        from: source,
        to: target,
        moved: moving.length,
        replaced: destination !== null,
      };
    });
    if (queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }

  async copy(from: string, to: string, options: CopyOptions = {}): Promise<CopyResult> {
    const source = this.normalizeAccessPath(from);
    const target = this.normalizeAccessPath(to, true);
    if (source === target) {
      throw new VfsError("EINVAL", "source and destination are the same path", target);
    }
    let queued = 0;
    const result = this.transaction(() => {
      const sourceEntry = this.requireEntry(source);
      if (sourceEntry.kind === "directory" && !(options.recursive ?? false)) {
        throw new VfsError("EISDIR", "recursive copy is required for directories", source);
      }
      if (sourceEntry.kind === "directory" && isDescendant(source, target)) {
        throw new VfsError("EINVAL", "cannot copy a directory into itself", target);
      }
      const destination = this.oneEntry(target);
      if (destination !== null && !(options.replace ?? false)) {
        throw new VfsError("EEXIST", "destination exists", target);
      }
      if (destination !== null && destination.kind === "directory") {
        const child = this.sql.exec<SqlRow>(
          "SELECT 1 AS present FROM vfs2_entries WHERE parent_path = ? LIMIT 1",
          target,
        ).toArray()[0];
        if (child !== undefined) throw new VfsError("ENOTEMPTY", "directory is not empty", target);
      }
      const now = this.now();
      this.ensureParents(target, options.createParents ?? false, now);
      const sourceRange = descendantRange(source);
      const sources = this.rows(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs2_entries e
         JOIN vfs2_path_versions p ON p.path = e.path
         WHERE e.path = ? OR (e.path >= ? AND e.path < ?)
         ORDER BY LENGTH(e.path)`,
        source,
        sourceRange.lower,
        sourceRange.upper,
      );
      const inlineBytes = sources.reduce(
        (total, row) => total + (row.contentClass === "inline" ? row.sizeBytes : 0),
        0,
      );
      const replacedInlineBytes = destination?.contentClass === "inline"
        ? destination.sizeBytes
        : 0;
      this.assertCapacity(
        inlineBytes - replacedInlineBytes,
        sources.length - (destination === null ? 0 : 1),
        target,
      );
      if (destination !== null) queued += this.removeExact(target, now);
      for (const row of sources) {
        const newPath = `${target}${row.path.slice(source.length)}`;
        const id = this.createId();
        this.bumpToken(newPath);
        this.sql.exec(
          `INSERT INTO vfs2_entries (
             id, path, parent_path, name, kind, content_class, opaque_object_id,
             size_bytes, mode, created_at_ms, modified_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          id,
          newPath,
          dirname(newPath),
          basename(newPath),
          row.kind,
          row.contentClass,
          row.opaqueObjectId,
          row.sizeBytes,
          row.mode,
          now,
          now,
        );
        if (row.contentClass === "inline") {
          const chunks = this.sql.exec<SqlRow>(
            `SELECT chunk_index, body FROM vfs2_inline_chunks
             WHERE entry_id = ? ORDER BY chunk_index`,
            row.id,
          ).toArray();
          for (const chunk of chunks) {
            this.sql.exec(
              `INSERT INTO vfs2_inline_chunks (entry_id, chunk_index, body)
               VALUES (?, ?, ?)`,
              id,
              integerColumn(chunk, "chunk_index"),
              blobColumn(chunk, "body"),
            );
          }
        }
      }
      this.updateUsage(
        inlineBytes - replacedInlineBytes,
        sources.length - (destination === null ? 0 : 1),
      );
      return {
        from: source,
        to: target,
        copied: sources.length,
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
      options.expectedSizeBytes !== undefined
      && (!Number.isSafeInteger(options.expectedSizeBytes) || options.expectedSizeBytes < 0)
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
        `INSERT INTO vfs2_upload_sessions (
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
      "createdAtMs",
      "modifiedAtMs",
      "revision",
    ] as const;
    if (
      receipt["kind"] !== "file"
      || receipt["contentClass"] !== "opaque"
      || strings.some((field) => typeof receipt[field] !== "string")
      || integers.some((field) => !Number.isSafeInteger(receipt[field]) || (receipt[field] as number) < 0)
      || (receipt["revision"] as number) < 1
      || (receipt["contentType"] !== undefined && typeof receipt["contentType"] !== "string")
      || (receipt["verifiedSha256"] !== undefined && typeof receipt["verifiedSha256"] !== "string")
    ) throw new VfsError("EIO", "invalid committed upload receipt", path);
    return receipt as unknown as OpaqueFileStat;
  }

  private markUploadGarbage(
    uploadId: string,
    objectKey: string,
    verificationToken: string,
    now: number,
  ): boolean {
    return this.transaction(() => {
      const session = this.upload(uploadId);
      if (
        session === null
        || session.state !== "verifying"
        || session.objectKey !== objectKey
        || session.verificationToken !== verificationToken
      ) return false;
      this.sql.exec(
        `UPDATE vfs2_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ? AND state = 'verifying' AND verification_token = ?`,
        uploadId,
        verificationToken,
      );
      this.queueUploadGarbage(session, now);
      return true;
    });
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
          this.sql.exec("DELETE FROM vfs2_upload_sessions WHERE id = ?", uploadId);
          return { expiredReceipt: session.path } as const;
        }
        return { committed: this.parseReceipt(session.receiptJson, session.path) } as const;
      }
      if (session.state === "garbage") {
        throw new VfsError("EREVISION", "upload session can no longer be committed", session.path);
      }
      const now = this.now();
      if (session.expiresAtMs <= now) {
        this.sql.exec("UPDATE vfs2_upload_sessions SET state = 'garbage' WHERE id = ?", uploadId);
        this.queueUploadGarbage(session, now);
        return { expired: session } as const;
      }
      if (
        session.state === "verifying"
        && (session.verificationLeaseUntilMs ?? 0) > now
      ) throw new VfsError("EAGAIN", "upload verification is already in progress", session.path);
      const verificationToken = this.newToken();
      this.sql.exec(
        `UPDATE vfs2_upload_sessions SET
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
          `UPDATE vfs2_upload_sessions SET
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
      if (!this.markUploadGarbage(
        uploadId,
        started.session.objectKey,
        started.verificationToken,
        this.now(),
      )) throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      await this.scheduleGarbageAlarm();
      throw new VfsError("EIO", "uploaded R2 object is missing", started.session.path);
    }
    if (metadata.key !== started.session.objectKey) {
      if (!this.markUploadGarbage(
        uploadId,
        started.session.objectKey,
        started.verificationToken,
        this.now(),
      )) throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      await this.scheduleGarbageAlarm();
      throw new VfsError("EIO", "object store returned metadata for the wrong key", started.session.path);
    }
    if (
      started.session.expectedSizeBytes !== null
      && metadata.sizeBytes !== started.session.expectedSizeBytes
    ) {
      if (!this.markUploadGarbage(
        uploadId,
        started.session.objectKey,
        started.verificationToken,
        this.now(),
      )) throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      await this.scheduleGarbageAlarm();
      throw new VfsError("EIO", "uploaded R2 object size does not match", started.session.path);
    }
    if (
      options.verifiedSha256 !== undefined
      && options.verifiedSha256 !== metadata.verifiedSha256
    ) {
      if (!this.markUploadGarbage(
        uploadId,
        started.session.objectKey,
        started.verificationToken,
        this.now(),
      )) throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
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
        session === null
        || session.state !== "verifying"
        || session.verificationToken !== started.verificationToken
      ) throw new VfsError("EREVISION", "upload verification lease was lost", started.session.path);
      if (this.tokenFor(session.path) !== session.expectedMutationToken) {
        this.sql.exec(
          `UPDATE vfs2_upload_sessions SET
             state = 'garbage', verification_token = NULL,
             verification_lease_until_ms = NULL
           WHERE id = ?`,
          uploadId,
        );
        this.queueUploadGarbage(session, this.now());
        return { stale: true, path: session.path } as const;
      }
      const existing = this.oneEntry(session.path);
      if (existing?.kind === "directory") throw new VfsError("EISDIR", "is a directory", session.path);
      const now = this.now();
      this.ensureParents(session.path, session.createParents, now);
      this.assertCapacity(
        existing?.contentClass === "inline" ? -existing.sizeBytes : 0,
        existing === null ? 1 : 0,
        session.path,
      );
      const objectId = this.createId();
      this.sql.exec(
        `INSERT INTO vfs2_opaque_objects (
           id, r2_key, size_bytes, etag, r2_version, verified_sha256,
           content_type, retain_until_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        objectId,
        metadata.key,
        metadata.sizeBytes,
        metadata.etag,
        metadata.version,
        metadata.verifiedSha256 ?? null,
        session.contentType ?? metadata.contentType ?? null,
        now,
      );
      if (existing?.contentClass === "inline") {
        this.sql.exec("DELETE FROM vfs2_inline_chunks WHERE entry_id = ?", existing.id);
      }
      const token = this.bumpToken(session.path);
      const id = existing?.id ?? this.createId();
      this.sql.exec(
        `INSERT INTO vfs2_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, created_at_ms, modified_at_ms, revision
         ) VALUES (?, ?, ?, ?, 'file', 'opaque', ?, ?, ?, ?, ?, 1)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'opaque', opaque_object_id = excluded.opaque_object_id,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms,
           revision = vfs2_entries.revision + 1`,
        id,
        session.path,
        dirname(session.path),
        basename(session.path),
        objectId,
        metadata.sizeBytes,
        session.mode ?? existing?.mode ?? FILE_MODE,
        existing?.createdAtMs ?? now,
        now,
      );
      this.updateUsage(
        existing?.contentClass === "inline" ? -existing.sizeBytes : 0,
        existing === null ? 1 : 0,
      );
      if (existing?.contentClass === "opaque" && existing.opaqueObjectId !== null) {
        this.queueObjectIfUnreferenced(existing.opaqueObjectId, now);
      }
      const baseStat = rowToStat(this.requireEntry(session.path));
      const stat = baseStat.kind === "file" && baseStat.contentClass === "opaque"
        ? {
            ...baseStat,
            ...(session.contentType ?? metadata.contentType) === undefined
              ? {}
              : { contentType: session.contentType ?? metadata.contentType },
            ...(metadata.verifiedSha256 === undefined
              ? {}
              : { verifiedSha256: metadata.verifiedSha256 }),
          }
        : baseStat;
      if (stat.kind !== "file" || stat.contentClass !== "opaque") {
        throw new VfsError("EIO", "committed entry is not opaque", session.path);
      }
      this.sql.exec(
        `UPDATE vfs2_upload_sessions SET
           state = 'committed', verification_token = NULL,
           verification_lease_until_ms = NULL, receipt_json = ?, expires_at_ms = ?
         WHERE id = ?`,
        JSON.stringify(stat),
        now + this.receiptRetentionMs,
        uploadId,
      );
      if (token !== stat.mutationToken) {
        throw new VfsError("EIO", "path token publication failed", session.path);
      }
      return { stale: false, stat } as const;
    });
    if (committed.stale) {
      await this.scheduleGarbageAlarm();
      throw new VfsError("EREVISION", "path changed after upload reservation", committed.path);
    }
    await this.scheduleGarbageAlarm();
    return committed.stat;
  }

  async abortOpaqueUpload(uploadId: string): Promise<void> {
    let queued = false;
    this.transaction(() => {
      const session = this.upload(uploadId);
      if (session === null || session.state === "garbage" || session.state === "committed") return;
      this.sql.exec(
        `UPDATE vfs2_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ?`,
        uploadId,
      );
      this.queueUploadGarbage(session, this.now());
      queued = true;
    });
    if (queued) await this.scheduleGarbageAlarm();
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
      if (object === null) throw new VfsError("EIO", "opaque object metadata is missing", normalized);
      const leaseExpiresAtMs = this.now() + Math.min(leaseMs, MAX_READ_LEASE_MS);
      this.sql.exec(
        `UPDATE vfs2_opaque_objects
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
    const keys = this.transaction(() => {
      const expired = this.sql.exec<SqlRow>(
        `SELECT id, r2_key FROM vfs2_upload_sessions
         WHERE (state = 'open' AND expires_at_ms <= ?)
            OR (state = 'verifying' AND verification_lease_until_ms <= ?)
         LIMIT ?`,
        now,
        now,
        batchLimit,
      ).toArray();
      for (const row of expired) {
        const id = stringColumn(row, "id");
        this.sql.exec(
          `UPDATE vfs2_upload_sessions SET
             state = 'garbage', verification_token = NULL,
             verification_lease_until_ms = NULL
           WHERE id = ?`,
          id,
        );
        const session = this.upload(id);
        if (session !== null) this.queueUploadGarbage(session, now);
      }
      this.sql.exec(
        "DELETE FROM vfs2_upload_sessions WHERE state = 'committed' AND expires_at_ms <= ?",
        now,
      );
      return this.sql.exec<SqlRow>(
        `SELECT r2_key FROM vfs2_gc_queue
         WHERE not_before_ms <= ? AND next_attempt_at_ms <= ?
         ORDER BY next_attempt_at_ms, not_before_ms LIMIT ?`,
        now,
        now,
        batchLimit,
      ).toArray().map((row) => stringColumn(row, "r2_key"));
    });
    if (store === undefined || keys.length === 0) {
      await this.scheduleGarbageAlarm();
      const remaining = integerColumn(
        this.sql.exec<SqlRow>("SELECT COUNT(*) AS value FROM vfs2_gc_queue").one(),
        "value",
      );
      return { deleted: 0, remaining };
    }
    try {
      await store.delete(keys);
      this.transaction(() => {
        for (const key of keys) {
          this.sql.exec(
            "DELETE FROM vfs2_upload_sessions WHERE state = 'garbage' AND r2_key = ?",
            key,
          );
          this.sql.exec("DELETE FROM vfs2_gc_queue WHERE r2_key = ?", key);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transaction(() => {
        for (const key of keys) {
          const row = this.sql.exec<SqlRow>(
            "SELECT attempts FROM vfs2_gc_queue WHERE r2_key = ?",
            key,
          ).toArray()[0];
          const attempts = row === undefined ? 1 : integerColumn(row, "attempts") + 1;
          const backoff = Math.min(2 ** Math.min(attempts, 12) * 1000, 60 * 60 * 1000);
          this.sql.exec(
            `UPDATE vfs2_gc_queue SET
               attempts = ?, next_attempt_at_ms = ?, last_error = ?
             WHERE r2_key = ?`,
            attempts,
            now + backoff,
            message,
            key,
          );
        }
      });
      await this.scheduleGarbageAlarm();
      throw error;
    }
    await this.scheduleGarbageAlarm();
    const remaining = integerColumn(
      this.sql.exec<SqlRow>("SELECT COUNT(*) AS value FROM vfs2_gc_queue").one(),
      "value",
    );
    return { deleted: keys.length, remaining };
  }
}
