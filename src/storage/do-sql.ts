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
  basename,
  depthFrom,
  descendantRange,
  dirname,
  isDescendant,
  normalizePath,
} from "../core/path.js";
import { replaceContent, searchContent } from "../core/search.js";
import type {
  BinaryRange,
  BinaryReadResult,
  BinaryStore,
  BinaryWriteResult,
  FindOptions,
  MoveResult,
  RegexEngine,
  RemoveOptions,
  RemoveResult,
  ReplaceTextOptions,
  ReplaceTextResult,
  TextReadResult,
  TextSearchOptions,
  TextSearchResult,
  TextSliceOptions,
  VfsStat,
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
  size_bytes, line_count, mode, created_at_ms, modified_at_ms,
  revision, r2_key
`;

interface EntryRow extends Record<string, SqlStorageValue> {
  path: string;
  parent_path: string;
  name: string;
  kind: "directory" | "file";
  content_kind: "binary" | "text" | null;
  content_state: "active" | "none" | "pending";
  size_bytes: number;
  line_count: number;
  mode: number;
  created_at_ms: number;
  modified_at_ms: number;
  revision: number;
  r2_key: string | null;
}

interface ChunkRow extends Record<string, SqlStorageValue> {
  body: ArrayBuffer;
  byte_length: number;
  newline_count: number;
}

interface SearchChunkRow extends ChunkRow {
  path: string;
}

interface BinaryKeyRow extends Record<string, SqlStorageValue> {
  r2_key: string;
}

interface CountRow extends Record<string, SqlStorageValue> {
  value: number;
}

export interface DurableObjectFileSystemOptions {
  chunkBytes?: number;
  maxTextFileBytes?: number;
  regexEngine?: RegexEngine;
  binaryStore?: BinaryStore;
  now?: () => number;
  createObjectKey?: () => string;
}

function rowToStat(row: EntryRow): VfsStat {
  return {
    path: row.path,
    parentPath: row.parent_path,
    name: row.name,
    kind: row.kind,
    contentKind: row.content_kind,
    sizeBytes: row.size_bytes,
    lineCount: row.line_count,
    mode: row.mode,
    createdAtMs: row.created_at_ms,
    modifiedAtMs: row.modified_at_ms,
    revision: row.revision,
  };
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
  private readonly regexEngine?: RegexEngine;
  private readonly binaryStore?: BinaryStore;
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

  private entry(path: string): EntryRow | null {
    const rows = this.sql
      .exec<EntryRow>(`SELECT ${ENTRY_COLUMNS} FROM vfs_entries WHERE path = ?`, path)
      .toArray();
    return rows[0] ?? null;
  }

  private requireEntry(path: string): EntryRow {
    const row = this.entry(path);
    if (!row) throw new VfsError("ENOENT", "no such file or directory", path);
    return row;
  }

  private requireDirectory(path: string): EntryRow {
    const row = this.requireEntry(path);
    if (row.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", path);
    return row;
  }

  private requireText(path: string): EntryRow {
    const row = this.requireEntry(path);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (row.content_kind !== "text" || row.content_state !== "active") {
      throw new VfsError("ENOTTEXT", "file is not an active text file", path);
    }
    if (row.size_bytes > this.maxTextFileBytes) {
      throw new VfsError(
        "E2BIG",
        `text file exceeds configured ${this.maxTextFileBytes}-byte read limit`,
        path,
      );
    }
    return row;
  }

  private createDirectory(path: string, now: number): void {
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
      DIRECTORY_MODE,
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
    return rowToStat(this.requireEntry(normalizePath(path)));
  }

  list(path: string): VfsStat[] {
    const normalized = normalizePath(path);
    this.requireDirectory(normalized);
    return this.sql
      .exec<EntryRow>(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs_entries WHERE parent_path = ? AND path <> '/'
         ORDER BY name`,
        normalized,
      )
      .toArray()
      .map(rowToStat);
  }

  find(options: FindOptions): VfsStat[] {
    const root = normalizePath(options.path);
    const rootEntry = this.requireEntry(root);
    const limit = Math.min(Math.max(options.limit ?? 10_000, 1), 100_000);
    const rows: EntryRow[] = [];

    if (rootEntry.kind === "file") {
      rows.push(rootEntry);
    } else {
      const range = descendantRange(root);
      const descendants = this.sql
        .exec<EntryRow>(
          `SELECT ${ENTRY_COLUMNS}
           FROM vfs_entries
           WHERE path >= ? AND path < ?
           ORDER BY path`,
          range.lower,
          range.upper,
        )
        .toArray();
      if (options.includeRoot && root !== "/") rows.push(rootEntry);
      rows.push(...descendants.filter((row) => row.path !== root));
    }

    const result: VfsStat[] = [];
    for (const row of rows) {
      if (options.type && row.kind !== options.type) continue;
      if (options.maxDepth !== undefined && depthFrom(root, row.path) > options.maxDepth) continue;
      if (!matchesGlob(row.name, options.name)) continue;
      if (!matchesGlob(row.path, options.pathGlob)) continue;
      result.push(rowToStat(row));
      if (result.length >= limit) break;
    }
    return result;
  }

  private textBytes(path: string): { stat: VfsStat; bytes: Uint8Array } {
    const stat = rowToStat(this.requireText(path));
    const chunks = this.sql
      .exec<ChunkRow>(
        `SELECT body, byte_length, newline_count
         FROM vfs_text_chunks WHERE path = ? ORDER BY chunk_index`,
        path,
      )
      .toArray()
      .map((row) => new Uint8Array(row.body));
    return { stat, bytes: concatenateBytes(chunks) };
  }

  readText(path: string): TextReadResult {
    const normalized = normalizePath(path);
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
  ): { stat: VfsStat; bytes: Uint8Array } {
    const stat = rowToStat(this.requireText(path));
    const byteLimit = options.bytes;
    const lineLimit = options.lines ?? (byteLimit === undefined ? 10 : undefined);
    const chunks: Uint8Array[] = [];
    let accumulatedBytes = 0;
    let accumulatedLines = 0;
    const cursor = this.sql.exec<ChunkRow>(
      `SELECT body, byte_length, newline_count
       FROM vfs_text_chunks WHERE path = ?
       ORDER BY chunk_index ${reverse ? "DESC" : "ASC"}`,
      path,
    );
    for (const row of cursor) {
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
    const normalized = normalizePath(path);
    const result = this.partialTextBytes(normalized, options, false);
    const sliced = options.bytes !== undefined
      ? headBytes(result.bytes, options.bytes)
      : headLines(result.bytes, options.lines ?? 10);
    return { stat: result.stat, text: decodeUtf8(sliced, normalized), bytesRead: sliced.byteLength };
  }

  readTextTail(path: string, options: TextSliceOptions): TextReadResult {
    const normalized = normalizePath(path);
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
      const root = normalizePath(requestedRoot);
      const entry = this.requireEntry(root);
      const range = descendantRange(root);
      const cursor = entry.kind === "file"
        ? this.sql.exec<SearchChunkRow>(
            `SELECT e.path, c.body, c.byte_length, c.newline_count
             FROM vfs_entries AS e
             JOIN vfs_text_chunks AS c ON c.path = e.path
             WHERE e.path = ? AND e.content_kind = 'text' AND e.content_state = 'active'
             ORDER BY e.path, c.chunk_index`,
            root,
          )
        : this.sql.exec<SearchChunkRow>(
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

      for (const row of cursor) {
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
    const normalized = normalizePath(path);
    if (normalized === "/") throw new VfsError("EISDIR", "cannot write the root directory", normalized);
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > this.maxTextFileBytes) {
      throw new VfsError(
        "E2BIG",
        `text exceeds configured ${this.maxTextFileBytes}-byte write limit`,
        normalized,
      );
    }
    const now = this.now();
    this.ensureParentDirectories(normalized, options.createParents ?? false, now);
    const existing = this.entry(normalized);
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

  replaceText(options: ReplaceTextOptions): ReplaceTextResult {
    return this.storage.transactionSync(() => {
      const normalized = normalizePath(options.path);
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

  mkdir(path: string, recursive = false): VfsStat {
    const normalized = normalizePath(path);
    return this.storage.transactionSync(() => {
      const existing = this.entry(normalized);
      if (existing) {
        if (existing.kind === "directory" && recursive) return rowToStat(existing);
        throw new VfsError("EEXIST", "file or directory already exists", normalized);
      }
      const now = this.now();
      if (recursive) {
        for (const ancestor of [...ancestorPaths(normalized), normalized]) {
          this.createDirectory(ancestor, now);
        }
      } else {
        this.createDirectory(normalized, now);
      }
      return rowToStat(this.requireDirectory(normalized));
    });
  }

  async remove(path: string, options: RemoveOptions = {}): Promise<RemoveResult> {
    const normalized = normalizePath(path);
    if (normalized === "/") throw new VfsError("EINVAL", "cannot remove the root directory", normalized);
    const target = this.requireEntry(normalized);
    if (target.kind === "directory" && !options.recursive) {
      const children = this.sql
        .exec<CountRow>("SELECT COUNT(*) AS value FROM vfs_entries WHERE parent_path = ?", normalized)
        .one().value;
      if (children > 0) throw new VfsError("ENOTEMPTY", "directory is not empty", normalized);
    }

    const range = descendantRange(normalized);
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM vfs_entries
         WHERE path = ? OR (path >= ? AND path < ?)
         ORDER BY path DESC`,
        normalized,
        range.lower,
        range.upper,
      )
      .toArray();
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
    const queued = this.sql.exec<CountRow>("SELECT COUNT(*) AS value FROM vfs_binary_gc").one().value;
    return { removed: rows.length, binaryObjectsQueuedForDeletion: queued };
  }

  move(from: string, to: string): MoveResult {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === "/" || target === "/") {
      throw new VfsError("EINVAL", "cannot move from or to the root directory");
    }
    if (source === target) return { from: source, to: target, moved: 0 };
    const sourceEntry = this.requireEntry(source);
    if (sourceEntry.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory inside itself", target);
    }

    return this.storage.transactionSync(() => {
      if (this.entry(target)) throw new VfsError("EEXIST", "destination already exists", target);
      this.requireDirectory(dirname(target));
      const range = descendantRange(source);
      const moved = this.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS value FROM vfs_entries
           WHERE path = ? OR (path >= ? AND path < ?)`,
          source,
          range.lower,
          range.upper,
        )
        .one().value;
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
      return { from: source, to: target, moved };
    });
  }

  async writeBinary(
    path: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options: { createParents?: boolean; mode?: number } = {},
  ): Promise<BinaryWriteResult> {
    if (!this.binaryStore) throw new VfsError("ENOSYS", "binary storage is not configured");
    const normalized = normalizePath(path);
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

    const activated = this.sql
      .exec<EntryRow>(
        `UPDATE vfs_entries
         SET content_state = 'active', size_bytes = ?, modified_at_ms = ?
         WHERE r2_key = ? AND content_state = 'pending'
         RETURNING ${ENTRY_COLUMNS}`,
        stored.size,
        this.now(),
        objectKey,
      )
      .toArray();
    if (activated.length === 0) {
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
    const result = rowToStat(activated[0]);
    return {
      path: result.path,
      revision: result.revision,
      sizeBytes: result.sizeBytes,
      created: true,
      objectKey,
    };
  }

  async readBinary(path: string, range?: BinaryRange): Promise<BinaryReadResult> {
    if (!this.binaryStore) throw new VfsError("ENOSYS", "binary storage is not configured");
    const normalized = normalizePath(path);
    const row = this.requireEntry(normalized);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (row.content_kind !== "binary" || row.content_state !== "active" || !row.r2_key) {
      throw new VfsError("EIO", "binary file is not active", normalized);
    }
    const bytes = await this.binaryStore.get(row.r2_key, range);
    if (!bytes) throw new VfsError("EIO", "binary object is missing", normalized);
    return { stat: rowToStat(row), bytes: copyArrayBuffer(bytes) };
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
      .exec<BinaryKeyRow>(
        "SELECT r2_key FROM vfs_binary_gc ORDER BY queued_at_ms LIMIT ?",
        safeLimit,
      )
      .toArray()
      .map((row) => row.r2_key);
    const deleted = await this.deleteBinaryKeys(keys);
    const remaining = this.sql
      .exec<CountRow>("SELECT COUNT(*) AS value FROM vfs_binary_gc")
      .one().value;
    return { deleted, remaining };
  }
}
