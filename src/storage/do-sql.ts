import {
  concatenateBytes,
  copyArrayBuffer,
  countNewlines,
  decodeUtf8,
  headBytes,
  headLines,
  tailBytes,
  tailLines,
} from "../core/bytes.js";
import { VfsError } from "../core/errors.js";
import { matchesGlob } from "../core/glob.js";
import {
  matchesFindPage,
  resolveFindCursor,
  resolveListCursor,
  resolvePageLimit,
  scanPage,
} from "../core/pagination.js";
import {
  basename,
  descendantRange,
  dirname,
  isDescendant,
  normalizePath,
  pathRequiresDirectory,
} from "../core/path.js";
import { replaceContent, searchContent } from "../core/search.js";
import type {
  AppendTextOptions,
  BinaryRange,
  BinaryFileStat,
  BinaryReadResult,
  BinaryStore,
  BinaryStreamReadResult,
  BinaryWriteResult,
  BinaryWriteOptions,
  EntryPage,
  FindOptions,
  FindPageOptions,
  MetadataUpdateOptions,
  MoveOptions,
  MoveResult,
  PageOptions,
  RegexEngine,
  RemoveOptions,
  RemoveResult,
  ReplaceTextOptions,
  ReplaceTextResult,
  TextReadResult,
  TextFileStat,
  TextSearchOptions,
  TextSearchResult,
  TextSliceOptions,
  TouchOptions,
  VfsStat,
  VfsStatMetadata,
  DirectoryStat,
  VirtualFileSystem,
  WriteResult,
  WriteTextOptions,
} from "../core/types.js";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024;
const DIRECTORY_MODE = 0o040755;
const FILE_MODE = 0o100644;

const ENTRY_COLUMNS = `
  path, parent_path, name, kind, content_kind, content_state,
  size_bytes, line_count, word_count, mode, created_at_ms, modified_at_ms,
  revision, r2_key
`;

type SqlRow = Readonly<Record<string, SqlStorageValue>>;

interface EntryRowMetadata {
  readonly path: string;
  readonly parent_path: string;
  readonly name: string;
  readonly size_bytes: number;
  readonly line_count: number;
  readonly word_count: number;
  readonly mode: number;
  readonly created_at_ms: number;
  readonly modified_at_ms: number;
  readonly revision: number;
}

interface DirectoryEntryRow extends EntryRowMetadata {
  readonly kind: "directory";
  readonly content_kind: null;
  readonly content_state: "none";
  readonly r2_key: null;
}

interface TextEntryRow extends EntryRowMetadata {
  readonly kind: "file";
  readonly content_kind: "text";
  readonly content_state: "active";
  readonly r2_key: null;
}

interface BinaryEntryRow extends EntryRowMetadata {
  readonly kind: "file";
  readonly content_kind: "binary";
  readonly content_state: "active" | "pending";
  readonly r2_key: string;
}

type EntryRow = DirectoryEntryRow | TextEntryRow | BinaryEntryRow;

interface ChunkRow {
  readonly body: ArrayBuffer;
  readonly byte_length: number;
  readonly newline_count: number;
}

interface SearchChunkRow extends ChunkRow {
  readonly path: string;
}

interface ActiveBinaryFile {
  objectKey: string;
  stat: BinaryFileStat;
  store: BinaryStore;
}

export interface DurableObjectFileSystemOptions {
  chunkBytes?: number;
  maxTextFileBytes?: number;
  regexEngine?: RegexEngine;
  binaryStore?: BinaryStore;
  now?: () => number;
  createObjectKey?: () => string;
}

function invalidSqlColumn(column: string, expected: string): never {
  throw new VfsError("EIO", `invalid SQLite row: ${column} must be ${expected}`);
}

function stringColumn(row: SqlRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : invalidSqlColumn(column, "text");
}

function nullableStringColumn(row: SqlRow, column: string): string | null {
  const value = row[column];
  return value === null || typeof value === "string"
    ? value
    : invalidSqlColumn(column, "text or null");
}

function integerColumn(row: SqlRow, column: string): number {
  const value = row[column];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : invalidSqlColumn(column, "a safe integer");
}

function nullableIntegerColumn(row: SqlRow, column: string): number | null {
  const value = row[column];
  return value === null || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : invalidSqlColumn(column, "a safe integer or null");
}

function arrayBufferColumn(row: SqlRow, column: string): ArrayBuffer {
  const value = row[column];
  return value instanceof ArrayBuffer ? value : invalidSqlColumn(column, "a blob");
}

function parseEntryRow(row: SqlRow): EntryRow {
  const metadata: EntryRowMetadata = {
    path: stringColumn(row, "path"),
    parent_path: stringColumn(row, "parent_path"),
    name: stringColumn(row, "name"),
    size_bytes: integerColumn(row, "size_bytes"),
    line_count: integerColumn(row, "line_count"),
    word_count: integerColumn(row, "word_count"),
    mode: integerColumn(row, "mode"),
    created_at_ms: integerColumn(row, "created_at_ms"),
    modified_at_ms: integerColumn(row, "modified_at_ms"),
    revision: integerColumn(row, "revision"),
  };
  const kind = stringColumn(row, "kind");
  const contentKind = nullableStringColumn(row, "content_kind");
  const contentState = stringColumn(row, "content_state");
  const objectKey = nullableStringColumn(row, "r2_key");

  if (kind === "directory" && contentKind === null && contentState === "none" && objectKey === null) {
    return {
      ...metadata,
      kind,
      content_kind: contentKind,
      content_state: contentState,
      r2_key: objectKey,
    };
  }
  if (kind === "file" && contentKind === "text" && contentState === "active" && objectKey === null) {
    return {
      ...metadata,
      kind,
      content_kind: contentKind,
      content_state: contentState,
      r2_key: objectKey,
    };
  }
  if (
    kind === "file"
    && contentKind === "binary"
    && (contentState === "active" || contentState === "pending")
    && objectKey !== null
  ) {
    return {
      ...metadata,
      kind,
      content_kind: contentKind,
      content_state: contentState,
      r2_key: objectKey,
    };
  }
  throw new VfsError("EIO", "invalid SQLite entry state", metadata.path);
}

function parseChunkRow(row: SqlRow): ChunkRow {
  return {
    body: arrayBufferColumn(row, "body"),
    byte_length: integerColumn(row, "byte_length"),
    newline_count: integerColumn(row, "newline_count"),
  };
}

function parseSearchChunkRow(row: SqlRow): SearchChunkRow {
  return { ...parseChunkRow(row), path: stringColumn(row, "path") };
}

function rowToStat(row: DirectoryEntryRow): DirectoryStat;
function rowToStat(row: TextEntryRow): TextFileStat;
function rowToStat(row: BinaryEntryRow): BinaryFileStat;
function rowToStat(row: EntryRow): VfsStat;
function rowToStat(row: EntryRow): VfsStat {
  const metadata: VfsStatMetadata = {
    path: row.path,
    parentPath: row.parent_path,
    name: row.name,
    sizeBytes: row.size_bytes,
    lineCount: row.line_count,
    mode: row.mode,
    createdAtMs: row.created_at_ms,
    modifiedAtMs: row.modified_at_ms,
    revision: row.revision,
  };
  if (row.kind === "directory") {
    return { ...metadata, kind: row.kind, contentKind: row.content_kind };
  }
  if (row.content_kind === "text") {
    return { ...metadata, kind: row.kind, contentKind: row.content_kind };
  }
  return { ...metadata, kind: row.kind, contentKind: row.content_kind };
}

function ancestorPaths(path: string): string[] {
  const normalized = normalizePath(path);
  const parents: string[] = [];
  let parent = dirname(normalized);
  while (parent !== "/") {
    parents.unshift(parent);
    parent = dirname(parent);
  }
  return parents;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

export class DurableObjectFileSystem implements VirtualFileSystem {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private readonly chunkBytes: number;
  private readonly maxTextFileBytes: number;
  private readonly regexEngine: RegexEngine | undefined;
  private readonly binaryStore: BinaryStore | undefined;
  private readonly now: () => number;
  private readonly createObjectKey: () => string;

  constructor(storage: DurableObjectStorage, options: DurableObjectFileSystemOptions = {}) {
    this.storage = storage;
    this.sql = storage.sql;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxTextFileBytes = options.maxTextFileBytes ?? DEFAULT_MAX_TEXT_FILE_BYTES;
    this.regexEngine = options.regexEngine;
    this.binaryStore = options.binaryStore;
    this.now = options.now ?? Date.now;
    this.createObjectKey = options.createObjectKey ?? (() => `vfs/${crypto.randomUUID()}`);

    if (
      !Number.isInteger(this.chunkBytes) ||
      this.chunkBytes < 1024 ||
      this.chunkBytes > 1024 * 1024
    ) {
      throw new RangeError("chunkBytes must be an integer from 1 KiB to 1 MiB");
    }
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vfs_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vfs_entries (
        path TEXT PRIMARY KEY,
        parent_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
        content_kind TEXT CHECK (content_kind IN ('text', 'binary')),
        content_state TEXT NOT NULL CHECK (content_state IN ('none', 'pending', 'active')),
        size_bytes INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        modified_at_ms INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        r2_key TEXT UNIQUE,
        UNIQUE (parent_path, name)
      );
      CREATE INDEX IF NOT EXISTS vfs_entries_parent_name
        ON vfs_entries(parent_path, name);
      CREATE INDEX IF NOT EXISTS vfs_entries_kind_path
        ON vfs_entries(kind, path);
      CREATE TABLE IF NOT EXISTS vfs_text_chunks (
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        byte_start INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        newline_count INTEGER NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (path, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS vfs_binary_gc (
        r2_key TEXT PRIMARY KEY,
        queued_at_ms INTEGER NOT NULL
      );
    `);

    const now = this.now();
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO vfs_schema_migrations (version, applied_at_ms)
         VALUES (1, ?)`,
        now,
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO vfs_entries (
           path, parent_path, name, kind, content_kind, content_state,
           size_bytes, line_count, word_count, mode, created_at_ms,
           modified_at_ms, revision, r2_key
         ) VALUES ('/', '/', '/', 'directory', NULL, 'none', 0, 0, 0, ?, ?, ?, 1, NULL)`,
        DIRECTORY_MODE,
        now,
        now,
      );
    });
  }

  private entryRows(query: string, ...bindings: SqlStorageValue[]): EntryRow[] {
    return this.sql.exec<SqlRow>(query, ...bindings).toArray().map(parseEntryRow);
  }

  private count(query: string, ...bindings: SqlStorageValue[]): number {
    return integerColumn(this.sql.exec<SqlRow>(query, ...bindings).one(), "value");
  }

  private entry(path: string): EntryRow | null {
    const rows = this.entryRows(`SELECT ${ENTRY_COLUMNS} FROM vfs_entries WHERE path = ?`, path);
    return rows[0] ?? null;
  }

  private normalizeAccessPath(path: string, allowMissingDirectory = false): string {
    const normalized = normalizePath(path);
    if (!pathRequiresDirectory(path) || normalized === "/") return normalized;
    const row = this.entry(normalized);
    if (!row) {
      if (allowMissingDirectory) return normalized;
      throw new VfsError("ENOENT", "no such directory", normalized);
    }
    if (row.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", normalized);
    return normalized;
  }

  private requireEntry(path: string): EntryRow {
    const row = this.entry(path);
    if (!row) throw new VfsError("ENOENT", "no such file or directory", path);
    return row;
  }

  private requireDirectory(path: string): DirectoryEntryRow {
    const row = this.requireEntry(path);
    if (row.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", path);
    return row;
  }

  private requireText(path: string): TextEntryRow {
    const row = this.requireEntry(path);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (row.content_kind !== "text") {
      throw new VfsError("ENOTTEXT", "file is not an active text file", path);
    }
    if (row.size_bytes > this.maxTextFileBytes) {
      throw new VfsError(
        "EFBIG",
        `text file exceeds configured ${this.maxTextFileBytes}-byte read limit`,
        path,
      );
    }
    return row;
  }

  private createDirectory(path: string, now: number, mode = DIRECTORY_MODE): void {
    const parentPath = dirname(path);
    const existing = this.entry(path);
    if (existing) {
      if (existing.kind !== "directory") {
        throw new VfsError("ENOTDIR", "path component is not a directory", path);
      }
      return;
    }
    this.requireDirectory(parentPath);
    this.sql.exec(
      `INSERT INTO vfs_entries (
         path, parent_path, name, kind, content_kind, content_state,
         size_bytes, line_count, word_count, mode, created_at_ms,
         modified_at_ms, revision, r2_key
       ) VALUES (?, ?, ?, 'directory', NULL, 'none', 0, 0, 0, ?, ?, ?, 1, NULL)`,
      path,
      parentPath,
      basename(path),
      mode,
      now,
      now,
    );
  }

  private ensureParentDirectories(path: string, recursive: boolean, now: number): void {
    const parentPath = dirname(path);
    if (!recursive) {
      this.requireDirectory(parentPath);
      return;
    }
    for (const ancestor of ancestorPaths(path)) this.createDirectory(ancestor, now);
    this.requireDirectory(parentPath);
  }

  stat(path: string): VfsStat {
    return rowToStat(this.requireEntry(this.normalizeAccessPath(path)));
  }

  list(path: string): VfsStat[] {
    const normalized = this.normalizeAccessPath(path);
    this.requireDirectory(normalized);
    return this.entryRows(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs_entries WHERE parent_path = ? AND path <> '/'
         ORDER BY name`,
        normalized,
      )
      .map(rowToStat);
  }

  listPage(path: string, options: PageOptions = {}): EntryPage {
    const normalized = this.normalizeAccessPath(path);
    this.requireDirectory(normalized);
    const limit = resolvePageLimit(options.limit);
    const cursor = resolveListCursor(normalized, options.cursor);
    const rows = this.entryRows(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs_entries
         WHERE parent_path = ? AND path <> '/' AND path > ?
         ORDER BY path LIMIT ?`,
        normalized,
        cursor ?? normalized,
        limit + 1,
      );
    const page = scanPage(rows, limit);
    return {
      entries: page.candidates.map(rowToStat),
      nextCursor: page.nextCursor,
      scanned: page.scanned,
    };
  }

  find(options: FindOptions): VfsStat[] {
    const limit = Math.min(Math.max(options.limit ?? 10_000, 1), 100_000);
    const result: VfsStat[] = [];
    let cursor: string | undefined;
    do {
      const page = this.findPage({
        ...options,
        limit: Math.min(limit, 1000),
        ...(cursor === undefined ? {} : { cursor }),
      });
      result.push(...page.entries.slice(0, limit - result.length));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && result.length < limit);
    return result;
  }

  findPage(options: FindPageOptions): EntryPage {
    const root = this.normalizeAccessPath(options.path);
    const rootEntry = this.requireEntry(root);
    const limit = resolvePageLimit(options.limit);
    const cursor = resolveFindCursor(root, options.cursor);

    const raw: EntryRow[] = [];
    if (rootEntry.kind === "file") {
      if (cursor === null) raw.push(rootEntry);
    } else {
      if (cursor === null && options.includeRoot && root !== "/") raw.push(rootEntry);
      const range = descendantRange(root);
      const remaining = limit + 1 - raw.length;
      if (remaining > 0) {
        raw.push(...this.entryRows(
            `SELECT ${ENTRY_COLUMNS}
             FROM vfs_entries
             WHERE path >= ? AND path < ? AND path > ?
             ORDER BY path LIMIT ?`,
            range.lower,
            range.upper,
            cursor ?? root,
            remaining,
          ));
      }
    }

    const page = scanPage(raw, limit);
    const entries = page.candidates
      .filter((row) => matchesFindPage(root, row, options))
      .map(rowToStat);
    return {
      entries,
      nextCursor: page.nextCursor,
      scanned: page.scanned,
    };
  }

  private textBytes(path: string): { stat: TextFileStat; bytes: Uint8Array } {
    const stat = rowToStat(this.requireText(path));
    const chunks = this.sql
      .exec<SqlRow>(
        `SELECT body, byte_length, newline_count
         FROM vfs_text_chunks WHERE path = ? ORDER BY chunk_index`,
        path,
      )
      .toArray()
      .map(parseChunkRow)
      .map((row) => new Uint8Array(row.body));
    return { stat, bytes: concatenateBytes(chunks) };
  }

  readText(path: string): TextReadResult {
    const normalized = this.normalizeAccessPath(path);
    const result = this.textBytes(normalized);
    return {
      stat: result.stat,
      text: decodeUtf8(result.bytes, normalized),
      bytesRead: result.bytes.byteLength,
    };
  }

  private partialTextBytes(
    path: string,
    options: TextSliceOptions,
    reverse: boolean,
  ): { stat: TextFileStat; bytes: Uint8Array } {
    const stat = rowToStat(this.requireText(path));
    const byteLimit = options.bytes;
    const lineLimit = options.lines ?? (byteLimit === undefined ? 10 : undefined);
    const chunks: Uint8Array[] = [];
    let accumulatedBytes = 0;
    let accumulatedLines = 0;
    const cursor = this.sql.exec<SqlRow>(
      `SELECT body, byte_length, newline_count
       FROM vfs_text_chunks WHERE path = ?
       ORDER BY chunk_index ${reverse ? "DESC" : "ASC"}`,
      path,
    );
    for (const rawRow of cursor) {
      const row = parseChunkRow(rawRow);
      const body = new Uint8Array(row.body);
      if (reverse) chunks.unshift(body);
      else chunks.push(body);
      accumulatedBytes += row.byte_length;
      accumulatedLines += row.newline_count;
      if (byteLimit !== undefined && accumulatedBytes >= byteLimit) break;
      if (lineLimit !== undefined && accumulatedLines >= lineLimit + (reverse ? 1 : 0)) break;
    }
    return { stat, bytes: concatenateBytes(chunks) };
  }

  readTextHead(path: string, options: TextSliceOptions): TextReadResult {
    const normalized = this.normalizeAccessPath(path);
    const result = this.partialTextBytes(normalized, options, false);
    const sliced = options.bytes !== undefined
      ? headBytes(result.bytes, options.bytes)
      : headLines(result.bytes, options.lines ?? 10);
    return { stat: result.stat, text: decodeUtf8(sliced, normalized), bytesRead: sliced.byteLength };
  }

  readTextTail(path: string, options: TextSliceOptions): TextReadResult {
    const normalized = this.normalizeAccessPath(path);
    const result = this.partialTextBytes(normalized, options, true);
    const sliced = options.bytes !== undefined
      ? tailBytes(result.bytes, options.bytes)
      : tailLines(result.bytes, options.lines ?? 10);
    return { stat: result.stat, text: decodeUtf8(sliced, normalized), bytesRead: sliced.byteLength };
  }

  searchText(options: TextSearchOptions): TextSearchResult {
    if (options.pattern.length === 0) throw new VfsError("EINVAL", "pattern cannot be empty");
    const maximumResults = Math.min(Math.max(options.maxResults ?? 1000, 1), 10_000);
    const visited = new Set<string>();
    const matches: TextSearchResult["matches"] = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    let truncated = false;

    for (const requestedRoot of options.roots) {
      const root = this.normalizeAccessPath(requestedRoot);
      const entry = this.requireEntry(root);
      const range = descendantRange(root);
      const cursor = entry.kind === "file"
        ? this.sql.exec<SqlRow>(
            `SELECT e.path, c.body, c.byte_length, c.newline_count
             FROM vfs_entries AS e
             JOIN vfs_text_chunks AS c ON c.path = e.path
             WHERE e.path = ? AND e.content_kind = 'text' AND e.content_state = 'active'
             ORDER BY e.path, c.chunk_index`,
            root,
          )
        : this.sql.exec<SqlRow>(
            `SELECT e.path, c.body, c.byte_length, c.newline_count
             FROM vfs_entries AS e
             JOIN vfs_text_chunks AS c ON c.path = e.path
             WHERE e.path >= ? AND e.path < ?
               AND e.content_kind = 'text' AND e.content_state = 'active'
             ORDER BY e.path, c.chunk_index`,
            range.lower,
            range.upper,
          );

      let currentPath = "";
      let currentChunks: Uint8Array[] = [];
      const inspect = (): void => {
        if (currentPath.length === 0 || visited.has(currentPath)) return;
        visited.add(currentPath);
        if (!matchesGlob(currentPath, options.include)) return;
        const bytes = concatenateBytes(currentChunks);
        if (bytes.byteLength > this.maxTextFileBytes) {
          throw new VfsError("E2BIG", "text file exceeds configured search limit", currentPath);
        }
        filesScanned += 1;
        bytesScanned += bytes.byteLength;
        const remaining = maximumResults - matches.length;
        matches.push(
          ...searchContent(
            currentPath,
            decodeUtf8(bytes, currentPath),
            options.pattern,
            options.fixed ?? false,
            options.ignoreCase ?? false,
            this.regexEngine,
            remaining,
          ),
        );
        if (matches.length >= maximumResults) truncated = true;
      };

      for (const rawRow of cursor) {
        const row = parseSearchChunkRow(rawRow);
        if (row.path !== currentPath) {
          inspect();
          if (truncated) break;
          currentPath = row.path;
          currentChunks = [];
        }
        currentChunks.push(new Uint8Array(row.body));
      }
      if (!truncated) inspect();
      if (truncated) break;
    }

    return { matches, filesScanned, bytesScanned, truncated };
  }

  private writeTextInTransaction(
    path: string,
    text: string,
    options: WriteTextOptions,
  ): WriteResult {
    const normalized = this.normalizeAccessPath(path);
    if (normalized === "/") throw new VfsError("EISDIR", "cannot write the root directory", normalized);
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > this.maxTextFileBytes) {
      throw new VfsError(
        "EFBIG",
        `text exceeds configured ${this.maxTextFileBytes}-byte write limit`,
        normalized,
      );
    }
    const now = this.now();
    this.ensureParentDirectories(normalized, options.createParents ?? false, now);
    const existing = this.entry(normalized);
    const disposition = options.disposition ?? "upsert";
    if (disposition === "create" && existing) {
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    if (disposition === "replace" && !existing) {
      throw new VfsError("ENOENT", "no such file", normalized);
    }
    if (existing?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (existing?.content_kind === "binary") {
      throw new VfsError("ENOTTEXT", "binary files cannot be modified", normalized);
    }
    if (options.ifRevision !== undefined && existing?.revision !== options.ifRevision) {
      throw new VfsError("EREVISION", "file revision does not match", normalized);
    }

    const revision = existing ? existing.revision + 1 : 1;
    const createdAt = existing?.created_at_ms ?? now;
    const lineCount = countNewlines(encoded);
    const wordCount = countWords(text);
    this.sql.exec("DELETE FROM vfs_text_chunks WHERE path = ?", normalized);
    for (let offset = 0, index = 0; offset < encoded.byteLength; offset += this.chunkBytes, index += 1) {
      const chunk = encoded.slice(offset, offset + this.chunkBytes);
      this.sql.exec(
        `INSERT INTO vfs_text_chunks
           (path, chunk_index, byte_start, byte_length, newline_count, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
        normalized,
        index,
        offset,
        chunk.byteLength,
        countNewlines(chunk),
        chunk.buffer,
      );
    }
    this.sql.exec(
      `INSERT INTO vfs_entries (
         path, parent_path, name, kind, content_kind, content_state,
         size_bytes, line_count, word_count, mode, created_at_ms,
         modified_at_ms, revision, r2_key
       ) VALUES (?, ?, ?, 'file', 'text', 'active', ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET
         content_kind = 'text', content_state = 'active',
         size_bytes = excluded.size_bytes, line_count = excluded.line_count,
         word_count = excluded.word_count, mode = excluded.mode,
         modified_at_ms = excluded.modified_at_ms, revision = excluded.revision,
         r2_key = NULL`,
      normalized,
      dirname(normalized),
      basename(normalized),
      encoded.byteLength,
      lineCount,
      wordCount,
      options.mode ?? existing?.mode ?? FILE_MODE,
      createdAt,
      now,
      revision,
    );
    return { path: normalized, revision, sizeBytes: encoded.byteLength, created: !existing };
  }

  writeText(path: string, text: string, options: WriteTextOptions = {}): WriteResult {
    return this.storage.transactionSync(() => this.writeTextInTransaction(path, text, options));
  }

  appendText(path: string, text: string, options: AppendTextOptions = {}): WriteResult {
    return this.storage.transactionSync(() => {
      const normalized = this.normalizeAccessPath(path);
      const existing = this.requireText(normalized);
      if (options.ifRevision !== undefined && existing.revision !== options.ifRevision) {
        throw new VfsError("EREVISION", "file revision does not match", normalized);
      }
      const encoded = new TextEncoder().encode(text);
      if (existing.size_bytes + encoded.byteLength > this.maxTextFileBytes) {
        throw new VfsError(
          "EFBIG",
          `text exceeds configured ${this.maxTextFileBytes}-byte write limit`,
          normalized,
        );
      }
      if (encoded.byteLength === 0) {
        return {
          path: normalized,
          revision: existing.revision,
          sizeBytes: existing.size_bytes,
          created: false,
        };
      }

      const suffix = existing.size_bytes === 0
        ? ""
        : this.readTextTail(normalized, { bytes: 4 }).text;

      const lastIndex = nullableIntegerColumn(
        this.sql.exec<SqlRow>(
          "SELECT MAX(chunk_index) AS value FROM vfs_text_chunks WHERE path = ?",
          normalized,
        ).one(),
        "value",
      ) ?? -1;
      for (
        let offset = 0, index = lastIndex + 1;
        offset < encoded.byteLength;
        offset += this.chunkBytes, index += 1
      ) {
        const chunk = encoded.slice(offset, offset + this.chunkBytes);
        this.sql.exec(
          `INSERT INTO vfs_text_chunks
             (path, chunk_index, byte_start, byte_length, newline_count, body)
           VALUES (?, ?, ?, ?, ?, ?)`,
          normalized,
          index,
          existing.size_bytes + offset,
          chunk.byteLength,
          countNewlines(chunk),
          chunk.buffer,
        );
      }

      const joinsWord = /\S$/u.test(suffix) && /^\S/u.test(text);
      const revision = existing.revision + 1;
      const sizeBytes = existing.size_bytes + encoded.byteLength;
      this.sql.exec(
        `UPDATE vfs_entries SET
           size_bytes = ?, line_count = ?, word_count = ?,
           modified_at_ms = ?, revision = ?
         WHERE path = ?`,
        sizeBytes,
        existing.line_count + countNewlines(encoded),
        existing.word_count + countWords(text) - (joinsWord ? 1 : 0),
        this.now(),
        revision,
        normalized,
      );
      return { path: normalized, revision, sizeBytes, created: false };
    });
  }

  private setMetadataInTransaction(path: string, options: MetadataUpdateOptions): VfsStat {
    const normalized = this.normalizeAccessPath(path);
    const existing = this.requireEntry(normalized);
    if (options.ifRevision !== undefined && existing.revision !== options.ifRevision) {
      throw new VfsError("EREVISION", "file revision does not match", normalized);
    }
    const revision = existing.revision + 1;
    this.sql.exec(
      `UPDATE vfs_entries SET mode = ?, modified_at_ms = ?, revision = ? WHERE path = ?`,
      options.mode ?? existing.mode,
      options.modifiedAtMs ?? this.now(),
      revision,
      normalized,
    );
    return rowToStat(this.requireEntry(normalized));
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    return this.storage.transactionSync(() => this.setMetadataInTransaction(path, options));
  }

  touch(path: string, options: TouchOptions = {}): VfsStat {
    return this.storage.transactionSync(() => {
      const normalized = this.normalizeAccessPath(path);
      const existing = this.entry(normalized);
      if (existing) return this.setMetadataInTransaction(normalized, options);
      if (options.create === false) {
        throw new VfsError("ENOENT", "no such file or directory", normalized);
      }
      if (options.ifRevision !== undefined) {
        throw new VfsError("EREVISION", "file revision does not match", normalized);
      }
      this.writeTextInTransaction(normalized, "", {
        createParents: options.createParents ?? false,
        disposition: "create",
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
      if (options.modifiedAtMs !== undefined) {
        this.sql.exec(
          "UPDATE vfs_entries SET modified_at_ms = ? WHERE path = ?",
          options.modifiedAtMs,
          normalized,
        );
      }
      return rowToStat(this.requireEntry(normalized));
    });
  }

  replaceText(options: ReplaceTextOptions): ReplaceTextResult {
    return this.storage.transactionSync(() => {
      const normalized = this.normalizeAccessPath(options.path);
      const current = this.readText(normalized);
      if (options.ifRevision !== undefined && current.stat.revision !== options.ifRevision) {
        throw new VfsError("EREVISION", "file revision does not match", normalized);
      }
      const replaced = replaceContent(
        current.text,
        options.pattern,
        options.replacement,
        options.fixed ?? false,
        options.ignoreCase ?? false,
        options.global ?? false,
        this.regexEngine,
      );
      if (replaced.replacements === 0) {
        return {
          path: normalized,
          revision: current.stat.revision,
          sizeBytes: current.stat.sizeBytes,
          created: false,
          replacements: 0,
          changed: false,
        };
      }
      const written = this.writeTextInTransaction(normalized, replaced.value, {
        ifRevision: current.stat.revision,
        mode: current.stat.mode,
      });
      return { ...written, replacements: replaced.replacements, changed: true };
    });
  }

  mkdir(path: string, recursive = false, mode?: number): VfsStat {
    const normalized = this.normalizeAccessPath(path, true);
    return this.storage.transactionSync(() => {
      const existing = this.entry(normalized);
      if (existing) {
        if (existing.kind === "directory" && recursive) return rowToStat(existing);
        throw new VfsError("EEXIST", "file or directory already exists", normalized);
      }
      const now = this.now();
      if (recursive) {
        for (const ancestor of [...ancestorPaths(normalized), normalized]) {
          this.createDirectory(ancestor, now, ancestor === normalized ? mode : undefined);
        }
      } else {
        this.createDirectory(normalized, now, mode);
      }
      return rowToStat(this.requireDirectory(normalized));
    });
  }

  async remove(path: string, options: RemoveOptions = {}): Promise<RemoveResult> {
    const normalized = this.normalizeAccessPath(path);
    if (normalized === "/") throw new VfsError("EINVAL", "cannot remove the root directory", normalized);
    const target = this.requireEntry(normalized);
    if (target.kind === "directory" && !options.recursive) {
      const children = this.count(
        "SELECT COUNT(*) AS value FROM vfs_entries WHERE parent_path = ?",
        normalized,
      );
      if (children > 0) throw new VfsError("ENOTEMPTY", "directory is not empty", normalized);
    }

    const range = descendantRange(normalized);
    const rows = this.entryRows(
        `SELECT ${ENTRY_COLUMNS} FROM vfs_entries
         WHERE path = ? OR (path >= ? AND path < ?)
         ORDER BY path DESC`,
        normalized,
        range.lower,
        range.upper,
      );
    const binaryKeys = rows
      .map((row) => row.r2_key)
      .filter((key): key is string => key !== null);
    const now = this.now();
    this.storage.transactionSync(() => {
      for (const key of binaryKeys) {
        this.sql.exec(
          "INSERT OR IGNORE INTO vfs_binary_gc (r2_key, queued_at_ms) VALUES (?, ?)",
          key,
          now,
        );
      }
      this.sql.exec(
        `DELETE FROM vfs_text_chunks
         WHERE path = ? OR (path >= ? AND path < ?)`,
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
    });
    await this.deleteBinaryKeys(binaryKeys);
    const queued = this.count("SELECT COUNT(*) AS value FROM vfs_binary_gc");
    return { removed: rows.length, binaryObjectsQueuedForDeletion: queued };
  }

  move(from: string, to: string, options: MoveOptions = {}): MoveResult {
    const source = this.normalizeAccessPath(from);
    const target = this.normalizeAccessPath(to);
    if (source === "/" || target === "/") {
      throw new VfsError("EINVAL", "cannot move from or to the root directory");
    }
    if (source === target) return { from: source, to: target, moved: 0, replaced: false };
    const sourceEntry = this.requireEntry(source);
    if (sourceEntry.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory inside itself", target);
    }

    return this.storage.transactionSync(() => {
      this.requireDirectory(dirname(target));
      const targetEntry = this.entry(target);
      if (targetEntry && !options.replace) {
        throw new VfsError("EEXIST", "destination already exists", target);
      }
      if (targetEntry) {
        if (sourceEntry.kind === "directory" && targetEntry.kind !== "directory") {
          throw new VfsError("ENOTDIR", "cannot replace a file with a directory", target);
        }
        if (sourceEntry.kind !== "directory" && targetEntry.kind === "directory") {
          throw new VfsError("EISDIR", "cannot replace a directory with a file", target);
        }
        if (targetEntry.kind === "directory") {
          const children = this.count(
            "SELECT COUNT(*) AS value FROM vfs_entries WHERE parent_path = ?",
            target,
          );
          if (children > 0) {
            throw new VfsError("ENOTEMPTY", "destination directory is not empty", target);
          }
        }
        if (targetEntry.r2_key) {
          this.sql.exec(
            "INSERT OR IGNORE INTO vfs_binary_gc (r2_key, queued_at_ms) VALUES (?, ?)",
            targetEntry.r2_key,
            this.now(),
          );
        }
        this.sql.exec("DELETE FROM vfs_text_chunks WHERE path = ?", target);
        this.sql.exec("DELETE FROM vfs_entries WHERE path = ?", target);
      }
      const range = descendantRange(source);
      const moved = this.count(
          `SELECT COUNT(*) AS value FROM vfs_entries
           WHERE path = ? OR (path >= ? AND path < ?)`,
          source,
          range.lower,
          range.upper,
        );
      const substringStart = source.length + 1;
      this.sql.exec(
        `UPDATE vfs_text_chunks
         SET path = CASE WHEN path = ? THEN ? ELSE ? || substr(path, ?) END
         WHERE path = ? OR (path >= ? AND path < ?)`,
        source,
        target,
        target,
        substringStart,
        source,
        range.lower,
        range.upper,
      );
      this.sql.exec(
        `UPDATE vfs_entries SET
           path = CASE WHEN path = ? THEN ? ELSE ? || substr(path, ?) END,
           parent_path = CASE
             WHEN path = ? THEN ?
             ELSE ? || substr(parent_path, ?)
           END,
           name = CASE WHEN path = ? THEN ? ELSE name END,
           modified_at_ms = CASE WHEN path = ? THEN ? ELSE modified_at_ms END,
           revision = CASE WHEN path = ? THEN revision + 1 ELSE revision END
         WHERE path = ? OR (path >= ? AND path < ?)`,
        source,
        target,
        target,
        substringStart,
        source,
        dirname(target),
        target,
        substringStart,
        source,
        basename(target),
        source,
        this.now(),
        source,
        source,
        range.lower,
        range.upper,
      );
      return { from: source, to: target, moved, replaced: targetEntry !== null };
    });
  }

  async writeBinary(
    path: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options: BinaryWriteOptions = {},
  ): Promise<BinaryWriteResult> {
    if (!this.binaryStore) throw new VfsError("ENOTSUP", "binary storage is not configured");
    const normalized = this.normalizeAccessPath(path);
    const objectKey = this.createObjectKey();
    const now = this.now();
    this.storage.transactionSync(() => {
      this.ensureParentDirectories(normalized, options.createParents ?? false, now);
      if (this.entry(normalized)) throw new VfsError("EEXIST", "destination already exists", normalized);
      this.sql.exec(
        `INSERT INTO vfs_entries (
           path, parent_path, name, kind, content_kind, content_state,
           size_bytes, line_count, word_count, mode, created_at_ms,
           modified_at_ms, revision, r2_key
         ) VALUES (?, ?, ?, 'file', 'binary', 'pending', 0, 0, 0, ?, ?, ?, 1, ?)`,
        normalized,
        dirname(normalized),
        basename(normalized),
        options.mode ?? FILE_MODE,
        now,
        now,
        objectKey,
      );
      // Queue the key before the external write. If R2's response is ambiguous,
      // a later GC pass can still remove a possible orphan.
      this.sql.exec(
        "INSERT INTO vfs_binary_gc (r2_key, queued_at_ms) VALUES (?, ?)",
        objectKey,
        now,
      );
    });

    let stored: { size: number };
    try {
      stored = await this.binaryStore.put(objectKey, value);
    } catch (error) {
      this.sql.exec(
        "DELETE FROM vfs_entries WHERE r2_key = ? AND content_state = 'pending'",
        objectKey,
      );
      throw error;
    }

    const [activated] = this.entryRows(
        `UPDATE vfs_entries
         SET content_state = 'active', size_bytes = ?, modified_at_ms = ?
         WHERE r2_key = ? AND content_state = 'pending'
         RETURNING ${ENTRY_COLUMNS}`,
        stored.size,
        this.now(),
        objectKey,
      );
    if (!activated) {
      this.sql.exec(
        "INSERT OR IGNORE INTO vfs_binary_gc (r2_key, queued_at_ms) VALUES (?, ?)",
        objectKey,
        this.now(),
      );
      try {
        await this.binaryStore.delete(objectKey);
        this.sql.exec("DELETE FROM vfs_binary_gc WHERE r2_key = ?", objectKey);
      } catch {
        // Keep the GC row if an upload/remove race leaves an object behind.
      }
      throw new VfsError("ENOENT", "binary file was removed before upload completed", normalized);
    }
    this.sql.exec("DELETE FROM vfs_binary_gc WHERE r2_key = ?", objectKey);
    const result = rowToStat(activated);
    return {
      path: result.path,
      revision: result.revision,
      sizeBytes: result.sizeBytes,
      created: true,
      objectKey,
    };
  }

  async readBinary(path: string, range?: BinaryRange): Promise<BinaryReadResult> {
    const binary = this.requireActiveBinary(path);
    const bytes = await binary.store.get(binary.objectKey, range);
    if (!bytes) throw new VfsError("EIO", "binary object is missing", binary.stat.path);
    return { stat: binary.stat, bytes: copyArrayBuffer(bytes) };
  }

  private requireActiveBinary(path: string): ActiveBinaryFile {
    const store = this.binaryStore;
    if (!store) throw new VfsError("ENOTSUP", "binary storage is not configured");
    const normalized = this.normalizeAccessPath(path);
    const row = this.requireEntry(normalized);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (row.content_kind !== "binary" || row.content_state !== "active" || !row.r2_key) {
      throw new VfsError("EIO", "binary file is not active", normalized);
    }
    return { objectKey: row.r2_key, stat: rowToStat(row), store };
  }

  async readBinaryStream(path: string, range?: BinaryRange): Promise<BinaryStreamReadResult> {
    const binary = this.requireActiveBinary(path);
    let stream: ReadableStream<Uint8Array> | null;
    if (binary.store.getStream) {
      stream = await binary.store.getStream(binary.objectKey, range);
    } else {
      const bytes = await binary.store.get(binary.objectKey, range);
      stream = bytes === null ? null : new Blob([bytes]).stream();
    }
    if (!stream) throw new VfsError("EIO", "binary object is missing", binary.stat.path);
    return { stat: binary.stat, stream };
  }

  private async deleteBinaryKeys(keys: readonly string[]): Promise<number> {
    if (!this.binaryStore) return 0;
    let deleted = 0;
    for (const key of keys) {
      try {
        await this.binaryStore.delete(key);
        this.sql.exec("DELETE FROM vfs_binary_gc WHERE r2_key = ?", key);
        deleted += 1;
      } catch {
        // The durable GC row intentionally remains for a later retry.
      }
    }
    return deleted;
  }

  async drainBinaryGarbage(limit = 100): Promise<{ deleted: number; remaining: number }> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const keys = this.sql
      .exec<SqlRow>(
        "SELECT r2_key FROM vfs_binary_gc ORDER BY queued_at_ms LIMIT ?",
        safeLimit,
      )
      .toArray()
      .map((row) => stringColumn(row, "r2_key"));
    const deleted = await this.deleteBinaryKeys(keys);
    const remaining = this.count("SELECT COUNT(*) AS value FROM vfs_binary_gc");
    return { deleted, remaining };
  }
}
