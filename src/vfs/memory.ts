import { VfsError } from "../core/errors.js";
import { matchesGlob } from "../core/glob.js";
import {
  basename,
  compareUtf8,
  depthFrom,
  dirname,
  isDescendant,
  normalizePath,
  pathRequiresDirectory,
} from "../core/path.js";
import { collectRechunkedBytes, rechunk, streamFromChunks } from "./streams.js";
import {
  MAX_INLINE_FILE_BYTES,
  type AppendFileOptions,
  type BeginOpaqueUploadOptions,
  type ByteBody,
  type CommitOpaqueUploadOptions,
  type CopyOptions,
  type CopyResult,
  type DirectoryStat,
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

const DIRECTORY_MODE = 0o040755;
const FILE_MODE = 0o100644;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_INLINE_LOGICAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;
const DEFAULT_VERIFY_LEASE_MS = 60_000;
const DEFAULT_UPLOAD_SETTLEMENT_GRACE_MS = 60_000;
const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READ_LEASE_MS = 5 * 60 * 1000;
const MAX_READ_LEASE_MS = 60 * 60 * 1000;
const NEVER_MUTATED_TOKEN = "vfs:never-mutated";

interface BaseEntry {
  id: string;
  stat: VfsStat;
}

interface DirectoryEntry extends BaseEntry {
  stat: DirectoryStat;
}

interface InlineEntry extends BaseEntry {
  stat: InlineFileStat;
  chunks: Uint8Array[];
}

interface OpaqueEntry extends BaseEntry {
  stat: OpaqueFileStat;
  objectId: string;
}

type MemoryEntry = DirectoryEntry | InlineEntry | OpaqueEntry;

interface MemoryOpaqueObject {
  id: string;
  metadata: OpaqueObjectMetadata;
  retainUntilMs: number;
}

type UploadState = "open" | "verifying" | "committed" | "garbage";

interface UploadSession {
  id: string;
  path: string;
  expectedMutationToken: string;
  objectKey: string;
  state: UploadState;
  verificationToken?: string;
  verificationLeaseUntilMs?: number;
  expectedSizeBytes?: number;
  expiresAtMs: number;
  createParents: boolean;
  mode?: number;
  contentType?: string;
  receipt?: OpaqueFileStat;
}

interface GarbageItem {
  objectKey: string;
  notBeforeMs: number;
  nextAttemptAtMs: number;
  attempts: number;
  lastError?: string;
}

export interface MemoryFileSystemOptions {
  chunkBytes?: number;
  maxInlineFileBytes?: number;
  maxInlineLogicalBytes?: number;
  maxEntries?: number;
  maxInFlightBufferedBytes?: number;
  uploadSettlementGraceMs?: number;
  receiptRetentionMs?: number;
  opaqueStore?: OpaqueStore;
  now?: () => number;
  createId?: () => string;
  workspaceId?: string;
}

function cloneStat<T extends VfsStat>(stat: T): T {
  return { ...stat };
}

function isDirectory(entry: MemoryEntry): entry is DirectoryEntry {
  return entry.stat.kind === "directory";
}

function isInline(entry: MemoryEntry): entry is InlineEntry {
  return entry.stat.kind === "file" && entry.stat.contentClass === "inline";
}

function isOpaque(entry: MemoryEntry): entry is OpaqueEntry {
  return entry.stat.kind === "file" && entry.stat.contentClass === "opaque";
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VfsError("EINVAL", `${name} must be a positive safe integer`);
  }
}

export class MemoryFileSystem implements VirtualFileSystem {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly pathVersions = new Map<string, string>();
  private readonly opaqueObjects = new Map<string, MemoryOpaqueObject>();
  private readonly uploads = new Map<string, UploadSession>();
  private readonly garbage = new Map<string, GarbageItem>();
  private readonly chunkBytes: number;
  private readonly maxInlineFileBytes: number;
  private readonly maxInlineLogicalBytes: number;
  private readonly maxEntries: number;
  private readonly maxInFlightBufferedBytes: number;
  private readonly uploadSettlementGraceMs: number;
  private readonly receiptRetentionMs: number;
  private readonly opaqueStore: OpaqueStore | undefined;
  private readonly clock: () => number;
  private readonly createId: () => string;
  private readonly workspaceId: string;
  private logicalInlineBytes = 0;
  private inFlightBufferedBytes = 0;
  private fallbackClock = 1;
  private fallbackId = 1;

  constructor(options: MemoryFileSystemOptions = {}) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxInlineFileBytes = options.maxInlineFileBytes ?? MAX_INLINE_FILE_BYTES;
    this.maxInlineLogicalBytes = options.maxInlineLogicalBytes
      ?? DEFAULT_MAX_INLINE_LOGICAL_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxInFlightBufferedBytes = options.maxInFlightBufferedBytes
      ?? DEFAULT_MAX_IN_FLIGHT_BYTES;
    this.uploadSettlementGraceMs = options.uploadSettlementGraceMs
      ?? DEFAULT_UPLOAD_SETTLEMENT_GRACE_MS;
    this.receiptRetentionMs = options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS;
    this.opaqueStore = options.opaqueStore;
    this.clock = options.now ?? (() => this.fallbackClock++);
    this.createId = options.createId ?? (() => `memory-${this.fallbackId++}`);
    this.workspaceId = options.workspaceId ?? "memory";

    validatePositiveInteger(this.chunkBytes, "chunkBytes");
    validatePositiveInteger(this.maxInlineFileBytes, "maxInlineFileBytes");
    if (this.maxInlineFileBytes > MAX_INLINE_FILE_BYTES) {
      throw new VfsError("EINVAL", `maxInlineFileBytes cannot exceed ${MAX_INLINE_FILE_BYTES}`);
    }
    validatePositiveInteger(this.maxInlineLogicalBytes, "maxInlineLogicalBytes");
    validatePositiveInteger(this.maxEntries, "maxEntries");
    validatePositiveInteger(this.maxInFlightBufferedBytes, "maxInFlightBufferedBytes");
    validatePositiveInteger(this.uploadSettlementGraceMs, "uploadSettlementGraceMs");
    validatePositiveInteger(this.receiptRetentionMs, "receiptRetentionMs");

    const token = this.newToken();
    this.pathVersions.set("/", token);
    this.entries.set("/", {
      id: this.createId(),
      stat: {
        path: "/",
        parentPath: "/",
        name: "/",
        kind: "directory",
        contentClass: null,
        sizeBytes: 0,
        mode: DIRECTORY_MODE,
        createdAtMs: 0,
        modifiedAtMs: 0,
        revision: 1,
        mutationToken: token,
      },
    });
  }

  private now(): number {
    return this.clock();
  }

  private newToken(): string {
    return this.createId();
  }

  private tokenFor(path: string): string {
    const current = this.pathVersions.get(path);
    if (current !== undefined) return current;
    return NEVER_MUTATED_TOKEN;
  }

  private bumpToken(path: string): string {
    const token = this.newToken();
    this.pathVersions.set(path, token);
    return token;
  }

  private normalizeAccessPath(path: string, allowMissingDirectory = false): string {
    const normalized = normalizePath(path);
    if (!pathRequiresDirectory(path) || normalized === "/") return normalized;
    const entry = this.entries.get(normalized);
    if (entry === undefined) {
      if (allowMissingDirectory) return normalized;
      throw new VfsError("ENOENT", "no such directory", normalized);
    }
    if (!isDirectory(entry)) throw new VfsError("ENOTDIR", "not a directory", normalized);
    return normalized;
  }

  private entry(path: string): MemoryEntry {
    const entry = this.entries.get(normalizePath(path));
    if (entry === undefined) {
      throw new VfsError("ENOENT", "no such file or directory", normalizePath(path));
    }
    return entry;
  }

  private directory(path: string): DirectoryEntry {
    const entry = this.entry(path);
    if (!isDirectory(entry)) throw new VfsError("ENOTDIR", "not a directory", entry.stat.path);
    return entry;
  }

  private inline(path: string): InlineEntry {
    const entry = this.entry(path);
    if (isDirectory(entry)) throw new VfsError("EISDIR", "is a directory", entry.stat.path);
    if (!isInline(entry)) {
      throw new VfsError(
        "ENOTSUP",
        "opaque R2 content is not available to shell commands",
        entry.stat.path,
      );
    }
    return entry;
  }

  private validateGuard(
    path: string,
    entry: MemoryEntry | undefined,
    guard: { ifRevision?: number; ifMutationToken?: string },
  ): void {
    if (guard.ifRevision !== undefined && entry?.stat.revision !== guard.ifRevision) {
      throw new VfsError("EREVISION", "file revision does not match", path);
    }
    if (
      guard.ifMutationToken !== undefined
      && this.tokenFor(path) !== guard.ifMutationToken
    ) {
      throw new VfsError("EREVISION", "path mutation token does not match", path);
    }
  }

  private assertEntryCapacity(additional: number): void {
    if (this.entries.size + additional > this.maxEntries) {
      throw new VfsError("ENOSPC", "filesystem entry quota exceeded");
    }
  }

  private assertInlineCapacity(previousBytes: number, nextBytes: number, path: string): void {
    if (nextBytes > this.maxInlineFileBytes) {
      throw new VfsError(
        "EFBIG",
        `inline content exceeds the ${this.maxInlineFileBytes}-byte limit`,
        path,
      );
    }
    if (this.logicalInlineBytes - previousBytes + nextBytes > this.maxInlineLogicalBytes) {
      throw new VfsError("ENOSPC", "workspace inline-byte quota exceeded", path);
    }
  }

  private ensureParents(
    path: string,
    recursive: boolean,
    now: number,
    additionalEntries = 0,
  ): void {
    const missing: string[] = [];
    let current = dirname(path);
    while (!this.entries.has(current)) {
      missing.unshift(current);
      current = dirname(current);
    }
    this.directory(current);
    if (missing.length > 0 && !recursive) {
      throw new VfsError("ENOENT", "parent directory does not exist", dirname(path));
    }
    this.assertEntryCapacity(missing.length + additionalEntries);
    for (const parent of missing) this.createDirectory(parent, now, DIRECTORY_MODE);
  }

  private createDirectory(path: string, now: number, mode: number): DirectoryEntry {
    const token = this.bumpToken(path);
    const entry: DirectoryEntry = {
      id: this.createId(),
      stat: {
        path,
        parentPath: dirname(path),
        name: basename(path),
        kind: "directory",
        contentClass: null,
        sizeBytes: 0,
        mode,
        createdAtMs: now,
        modifiedAtMs: now,
        revision: 1,
        mutationToken: token,
      },
    };
    this.entries.set(path, entry);
    return entry;
  }

  private accountInFlight(delta: number): void {
    if (this.inFlightBufferedBytes + delta > this.maxInFlightBufferedBytes) {
      throw new VfsError("ENOSPC", "runtime in-flight byte budget exceeded");
    }
    this.inFlightBufferedBytes += delta;
  }

  private async collectInline(body: ByteBody): Promise<{
    chunks: Uint8Array[];
    release(): void;
  }> {
    let accounted = 0;
    try {
      const collected = await collectRechunkedBytes(
        body,
        this.maxInlineFileBytes,
        this.chunkBytes,
        (delta) => {
          this.accountInFlight(delta);
          accounted += delta;
        },
      );
      let released = false;
      return {
        chunks: collected.chunks,
        release: () => {
          if (released) return;
          released = true;
          this.inFlightBufferedBytes -= accounted;
        },
      };
    } catch (error) {
      this.inFlightBufferedBytes -= accounted;
      throw error;
    }
  }

  private queueObjectIfUnreferenced(objectId: string, now: number): boolean {
    for (const entry of this.entries.values()) {
      if (isOpaque(entry) && entry.objectId === objectId) return false;
    }
    const object = this.opaqueObjects.get(objectId);
    if (object === undefined) return false;
    this.opaqueObjects.delete(objectId);
    this.queueGarbage(object.metadata.key, Math.max(now, object.retainUntilMs));
    return true;
  }

  private queueGarbage(objectKey: string, notBeforeMs: number): void {
    const existing = this.garbage.get(objectKey);
    if (existing !== undefined) {
      existing.notBeforeMs = Math.max(existing.notBeforeMs, notBeforeMs);
      existing.nextAttemptAtMs = Math.max(existing.nextAttemptAtMs, notBeforeMs);
      return;
    }
    this.garbage.set(objectKey, {
      objectKey,
      notBeforeMs,
      nextAttemptAtMs: notBeforeMs,
      attempts: 0,
    });
  }

  private queueUploadGarbage(session: UploadSession, now: number): void {
    this.queueGarbage(
      session.objectKey,
      Math.max(now, session.expiresAtMs + this.uploadSettlementGraceMs),
    );
  }

  private removeExact(path: string, now: number): number {
    const entry = this.entries.get(path);
    if (entry === undefined) return 0;
    this.entries.delete(path);
    this.bumpToken(path);
    if (isInline(entry)) this.logicalInlineBytes -= entry.stat.sizeBytes;
    if (isOpaque(entry) && this.queueObjectIfUnreferenced(entry.objectId, now)) return 1;
    return 0;
  }

  stat(path: string): VfsStat {
    return cloneStat(this.entry(this.normalizeAccessPath(path)).stat);
  }

  getMutationToken(path: string): string {
    return this.tokenFor(normalizePath(path));
  }

  list(path: string): VfsStat[] {
    const normalized = this.normalizeAccessPath(path);
    this.directory(normalized);
    return [...this.entries.values()]
      .filter((entry) => entry.stat.path !== "/" && entry.stat.parentPath === normalized)
      .sort((left, right) => compareUtf8(left.stat.name, right.stat.name))
      .map((entry) => cloneStat(entry.stat));
  }

  listPage(path: string, options: PageOptions = {}): EntryPage {
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    const normalized = this.normalizeAccessPath(path);
    const entries = this.list(normalized)
      .filter((entry) => options.cursor === undefined || compareUtf8(entry.path, options.cursor) > 0);
    const page = entries.slice(0, limit);
    return {
      entries: page,
      nextCursor: entries.length > limit ? page.at(-1)?.path ?? null : null,
      scanned: page.length,
    };
  }

  find(options: FindOptions): VfsStat[] {
    const results: VfsStat[] = [];
    let cursor = options.cursor;
    do {
      const page = this.findPage({
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(options.limit ?? 1000, 1000),
      });
      results.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && results.length < (options.limit ?? 10_000));
    return results.slice(0, options.limit ?? 10_000);
  }

  findPage(options: FindOptions): EntryPage {
    const root = this.normalizeAccessPath(options.path);
    const rootEntry = this.entry(root);
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    const all = [...this.entries.values()]
      .map((entry) => entry.stat)
      .filter((stat) => stat.path === root
        ? options.cursor === undefined
          && (rootEntry.stat.kind === "file" || (options.includeRoot ?? false))
        : isDescendant(root, stat.path))
      .filter((stat) => options.cursor === undefined || compareUtf8(stat.path, options.cursor) > 0)
      .sort((left, right) => compareUtf8(left.path, right.path));
    const scanned = all.slice(0, limit);
    const entries = scanned.filter((stat) => {
      if (options.maxDepth !== undefined && depthFrom(root, stat.path) > options.maxDepth) return false;
      if (options.type !== undefined && stat.kind !== options.type) return false;
      if (options.name !== undefined && !matchesGlob(stat.name, options.name)) return false;
      if (options.pathGlob !== undefined && !matchesGlob(stat.path, options.pathGlob)) return false;
      return true;
    }).map(cloneStat);
    return {
      entries,
      nextCursor: all.length > limit ? scanned.at(-1)?.path ?? null : null,
      scanned: scanned.length,
    };
  }

  readFile(path: string): InlineReadResult {
    const entry = this.inline(this.normalizeAccessPath(path));
    const chunks = entry.chunks.map((chunk) => chunk.slice());
    const sizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    this.accountInFlight(sizeBytes);
    return {
      stat: cloneStat(entry.stat),
      stream: streamFromChunks(chunks, () => {
        this.inFlightBufferedBytes -= sizeBytes;
      }),
    };
  }

  async writeFile(
    path: string,
    body: ByteBody,
    options: WriteFileOptions = {},
  ): Promise<WriteResult> {
    const normalized = this.normalizeAccessPath(path, true);
    const before = this.entries.get(normalized);
    const disposition = options.disposition ?? "upsert";
    if (disposition === "create" && before !== undefined) {
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    if (disposition === "replace" && before === undefined) {
      throw new VfsError("ENOENT", "no such file", normalized);
    }
    if (before !== undefined && isDirectory(before)) {
      throw new VfsError("EISDIR", "is a directory", normalized);
    }
    this.validateGuard(normalized, before, options);
    const capturedToken = this.tokenFor(normalized);
    const buffered = await this.collectInline(body);
    const chunks = buffered.chunks;
    const sizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);

    try {
      const current = this.entries.get(normalized);
      if (this.tokenFor(normalized) !== capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", normalized);
      }
      this.validateGuard(normalized, current, options);
      const previousInlineBytes = current !== undefined && isInline(current)
        ? current.stat.sizeBytes
        : 0;
      this.assertInlineCapacity(previousInlineBytes, sizeBytes, normalized);
      const now = this.now();
      this.ensureParents(
        normalized,
        options.createParents ?? false,
        now,
        current === undefined ? 1 : 0,
      );
      const token = this.bumpToken(normalized);
      const stat: InlineFileStat = {
        path: normalized,
        parentPath: dirname(normalized),
        name: basename(normalized),
        kind: "file",
        contentClass: "inline",
        sizeBytes,
        mode: options.mode ?? current?.stat.mode ?? FILE_MODE,
        createdAtMs: current?.stat.createdAtMs ?? now,
        modifiedAtMs: now,
        revision: current === undefined ? 1 : current.stat.revision + 1,
        mutationToken: token,
      };
      const previousOpaqueId = current !== undefined && isOpaque(current)
        ? current.objectId
        : undefined;
      this.entries.set(normalized, {
        id: current?.id ?? this.createId(),
        stat,
        chunks,
      });
      this.logicalInlineBytes += sizeBytes - previousInlineBytes;
      if (previousOpaqueId !== undefined) this.queueObjectIfUnreferenced(previousOpaqueId, now);
      return {
        path: normalized,
        revision: stat.revision,
        mutationToken: token,
        sizeBytes,
        created: current === undefined,
      };
    } finally {
      buffered.release();
    }
  }

  async appendFile(
    path: string,
    body: ByteBody,
    options: AppendFileOptions = {},
  ): Promise<WriteResult> {
    const normalized = this.normalizeAccessPath(path);
    const before = this.inline(normalized);
    this.validateGuard(normalized, before, options);
    const capturedToken = before.stat.mutationToken;
    const buffered = await this.collectInline(body);
    const suffix = buffered.chunks;
    const suffixBytes = suffix.reduce((total, chunk) => total + chunk.byteLength, 0);
    try {
      const current = this.inline(normalized);
      if (current.stat.mutationToken !== capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", normalized);
      }
      this.validateGuard(normalized, current, options);
      if (suffixBytes === 0) {
        return {
          path: normalized,
          revision: current.stat.revision,
          mutationToken: capturedToken,
          sizeBytes: current.stat.sizeBytes,
          created: false,
        };
      }
      const combined = rechunk([...current.chunks, ...suffix], this.chunkBytes);
      const sizeBytes = current.stat.sizeBytes + suffixBytes;
      this.assertInlineCapacity(current.stat.sizeBytes, sizeBytes, normalized);
      const now = this.now();
      const token = this.bumpToken(normalized);
      current.chunks = combined;
      current.stat = {
        ...current.stat,
        sizeBytes,
        modifiedAtMs: now,
        revision: current.stat.revision + 1,
        mutationToken: token,
      };
      this.logicalInlineBytes += suffixBytes;
      return {
        path: normalized,
        revision: current.stat.revision,
        mutationToken: token,
        sizeBytes,
        created: false,
      };
    } finally {
      buffered.release();
    }
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    const normalized = this.normalizeAccessPath(path);
    const entry = this.entry(normalized);
    this.validateGuard(normalized, entry, options);
    const token = this.bumpToken(normalized);
    entry.stat = {
      ...entry.stat,
      mode: options.mode ?? entry.stat.mode,
      modifiedAtMs: options.modifiedAtMs ?? this.now(),
      revision: entry.stat.revision + 1,
      mutationToken: token,
    } as VfsStat;
    return cloneStat(entry.stat);
  }

  touch(path: string, options: TouchOptions = {}): VfsStat {
    const normalized = this.normalizeAccessPath(path, true);
    const existing = this.entries.get(normalized);
    if (existing !== undefined) return this.setMetadata(normalized, options);
    if (options.create === false) {
      throw new VfsError("ENOENT", "no such file or directory", normalized);
    }
    this.validateGuard(normalized, existing, options);
    const now = this.now();
    this.ensureParents(normalized, options.createParents ?? false, now, 1);
    this.assertInlineCapacity(0, 0, normalized);
    const token = this.bumpToken(normalized);
    const stat: InlineFileStat = {
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
    this.entries.set(normalized, { id: this.createId(), stat, chunks: [] });
    return cloneStat(stat);
  }

  mkdir(path: string, recursive = false, mode = DIRECTORY_MODE): VfsStat {
    const normalized = this.normalizeAccessPath(path, true);
    const existing = this.entries.get(normalized);
    if (existing !== undefined) {
      if (recursive && isDirectory(existing)) return cloneStat(existing.stat);
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    const now = this.now();
    this.ensureParents(normalized, recursive, now, 1);
    return cloneStat(this.createDirectory(normalized, now, mode).stat);
  }

  remove(path: string, options: RemoveOptions = {}): RemoveResult {
    const normalized = this.normalizeAccessPath(path);
    if (normalized === "/") throw new VfsError("EINVAL", "cannot remove root", normalized);
    const root = this.entry(normalized);
    const descendants = [...this.entries.keys()]
      .filter((candidate) => isDescendant(normalized, candidate))
      .sort((left, right) => right.length - left.length);
    if (isDirectory(root) && descendants.length > 0 && !(options.recursive ?? false)) {
      throw new VfsError("ENOTEMPTY", "directory is not empty", normalized);
    }
    const now = this.now();
    let queued = 0;
    for (const candidate of descendants) queued += this.removeExact(candidate, now);
    queued += this.removeExact(normalized, now);
    return { removed: descendants.length + 1, opaqueObjectsQueuedForDeletion: queued };
  }

  move(from: string, to: string, options: MoveOptions = {}): MoveResult {
    const source = this.normalizeAccessPath(from);
    const target = this.normalizeAccessPath(to, true);
    if (source === "/") throw new VfsError("EINVAL", "cannot move root", source);
    if (source === target) return { from: source, to: target, moved: 1, replaced: false };
    if (isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory into itself", target);
    }
    const sourceEntry = this.entry(source);
    this.directory(dirname(target));
    const destination = this.entries.get(target);
    if (destination !== undefined && !(options.replace ?? false)) {
      throw new VfsError("EEXIST", "destination exists", target);
    }
    if (destination !== undefined && isDirectory(destination)) {
      const children = [...this.entries.keys()].filter((path) => isDescendant(target, path));
      if (children.length > 0) throw new VfsError("ENOTEMPTY", "directory is not empty", target);
    }
    if (destination !== undefined && destination.stat.kind !== sourceEntry.stat.kind) {
      throw new VfsError(
        destination.stat.kind === "directory" ? "EISDIR" : "ENOTDIR",
        "source and destination kinds differ",
        target,
      );
    }
    const now = this.now();
    if (destination !== undefined) this.removeExact(target, now);
    const moving = [...this.entries.entries()]
      .filter(([path]) => path === source || isDescendant(source, path))
      .sort(([left], [right]) => left.length - right.length);
    for (const [path] of moving) this.entries.delete(path);
    for (const [oldPath, entry] of moving) {
      const newPath = `${target}${oldPath.slice(source.length)}`;
      const token = this.bumpToken(newPath);
      this.bumpToken(oldPath);
      entry.stat = {
        ...entry.stat,
        path: newPath,
        parentPath: dirname(newPath),
        name: basename(newPath),
        modifiedAtMs: oldPath === source ? now : entry.stat.modifiedAtMs,
        revision: entry.stat.revision + 1,
        mutationToken: token,
      } as VfsStat;
      this.entries.set(newPath, entry);
    }
    return {
      from: source,
      to: target,
      moved: moving.length,
      replaced: destination !== undefined,
    };
  }

  copy(from: string, to: string, options: CopyOptions = {}): CopyResult {
    const source = this.normalizeAccessPath(from);
    const target = this.normalizeAccessPath(to, true);
    if (source === target) {
      throw new VfsError("EINVAL", "source and destination are the same path", target);
    }
    const sourceEntry = this.entry(source);
    if (isDirectory(sourceEntry) && !(options.recursive ?? false)) {
      throw new VfsError("EISDIR", "recursive copy is required for directories", source);
    }
    if (isDirectory(sourceEntry) && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot copy a directory into itself", target);
    }
    const destination = this.entries.get(target);
    if (destination !== undefined && !(options.replace ?? false)) {
      throw new VfsError("EEXIST", "destination exists", target);
    }
    if (destination !== undefined && isDirectory(destination)) {
      const children = [...this.entries.keys()].filter((path) => isDescendant(target, path));
      if (children.length > 0) throw new VfsError("ENOTEMPTY", "directory is not empty", target);
    }
    const sources = [...this.entries.entries()]
      .filter(([path]) => path === source || (isDirectory(sourceEntry) && isDescendant(source, path)))
      .sort(([left], [right]) => left.length - right.length);
    const additionalEntries = sources.length - (destination === undefined ? 0 : 1);
    const inlineBytes = sources.reduce(
      (total, [, entry]) => total + (isInline(entry) ? entry.stat.sizeBytes : 0),
      0,
    );
    const replacedInlineBytes = destination !== undefined && isInline(destination)
      ? destination.stat.sizeBytes
      : 0;
    if (this.logicalInlineBytes - replacedInlineBytes + inlineBytes > this.maxInlineLogicalBytes) {
      throw new VfsError("ENOSPC", "workspace inline-byte quota exceeded", target);
    }
    const now = this.now();
    this.ensureParents(target, options.createParents ?? false, now, additionalEntries);
    if (destination !== undefined) this.removeExact(target, now);
    for (const [oldPath, entry] of sources) {
      const newPath = `${target}${oldPath.slice(source.length)}`;
      const token = this.bumpToken(newPath);
      const common = {
        ...entry.stat,
        path: newPath,
        parentPath: dirname(newPath),
        name: basename(newPath),
        createdAtMs: now,
        modifiedAtMs: now,
        revision: 1,
        mutationToken: token,
      };
      if (isDirectory(entry)) {
        this.entries.set(newPath, { id: this.createId(), stat: { ...common, kind: "directory", contentClass: null } });
      } else if (isInline(entry)) {
        this.entries.set(newPath, {
          id: this.createId(),
          stat: { ...common, kind: "file", contentClass: "inline" },
          chunks: entry.chunks.map((chunk) => chunk.slice()),
        });
      } else {
        this.entries.set(newPath, {
          id: this.createId(),
          stat: { ...common, kind: "file", contentClass: "opaque" },
          objectId: entry.objectId,
        });
      }
    }
    this.logicalInlineBytes += inlineBytes - replacedInlineBytes;
    return {
      from: source,
      to: target,
      copied: sources.length,
      replaced: destination !== undefined,
      opaqueBodiesCopied: 0,
    };
  }

  beginOpaqueUpload(
    path: string,
    options: BeginOpaqueUploadOptions = {},
  ): OpaqueUploadReservation {
    if (this.opaqueStore === undefined) {
      throw new VfsError("ENOTSUP", "opaque storage is not configured");
    }
    const normalized = this.normalizeAccessPath(path, true);
    const existing = this.entries.get(normalized);
    if (existing !== undefined && isDirectory(existing)) {
      throw new VfsError("EISDIR", "is a directory", normalized);
    }
    const expectedMutationToken = this.tokenFor(normalized);
    if (
      options.ifMutationToken !== undefined
      && options.ifMutationToken !== expectedMutationToken
    ) {
      throw new VfsError("EREVISION", "path mutation token does not match", normalized);
    }
    if (
      options.expectedSizeBytes !== undefined
      && (!Number.isSafeInteger(options.expectedSizeBytes) || options.expectedSizeBytes < 0)
    ) {
      throw new VfsError("EINVAL", "expectedSizeBytes must be a non-negative safe integer");
    }
    const expiresInMs = options.expiresInMs ?? DEFAULT_UPLOAD_TTL_MS;
    validatePositiveInteger(expiresInMs, "expiresInMs");
    const uploadId = this.createId();
    const objectKey = `vfs/${this.workspaceId}/objects/${this.createId()}`;
    const expiresAtMs = this.now() + expiresInMs;
    this.uploads.set(uploadId, {
      id: uploadId,
      path: normalized,
      expectedMutationToken,
      objectKey,
      state: "open",
      expiresAtMs,
      createParents: options.createParents ?? false,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.expectedSizeBytes === undefined
        ? {}
        : { expectedSizeBytes: options.expectedSizeBytes }),
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    });
    return {
      uploadId,
      path: normalized,
      objectKey,
      expectedMutationToken,
      expiresAtMs,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    };
  }

  async commitOpaqueUpload(
    uploadId: string,
    options: CommitOpaqueUploadOptions = {},
  ): Promise<OpaqueFileStat> {
    const store = this.opaqueStore;
    if (store === undefined) throw new VfsError("ENOTSUP", "opaque storage is not configured");
    const session = this.uploads.get(uploadId);
    if (session === undefined) throw new VfsError("ENOENT", "upload session does not exist");
    if (session.state === "committed" && session.receipt !== undefined) {
      if (session.expiresAtMs <= this.now()) {
        this.uploads.delete(uploadId);
        throw new VfsError("ENOENT", "committed upload receipt expired", session.path);
      }
      return cloneStat(session.receipt);
    }
    if (session.state === "garbage") {
      throw new VfsError("EREVISION", "upload session can no longer be committed", session.path);
    }
    const now = this.now();
    if (session.expiresAtMs <= now) {
      session.state = "garbage";
      this.queueUploadGarbage(session, now);
      throw new VfsError("ETIMEDOUT", "upload session expired", session.path);
    }
    if (session.state === "verifying") {
      if ((session.verificationLeaseUntilMs ?? 0) > now) {
        throw new VfsError("EAGAIN", "upload verification is already in progress");
      }
    }
    const verificationToken = this.newToken();
    session.state = "verifying";
    session.verificationToken = verificationToken;
    session.verificationLeaseUntilMs = now + DEFAULT_VERIFY_LEASE_MS;

    let metadata: OpaqueObjectMetadata | null;
    try {
      metadata = await store.head(session.objectKey);
    } catch (error) {
      if (session.state === "verifying" && session.verificationToken === verificationToken) {
        session.state = "open";
        delete session.verificationToken;
        delete session.verificationLeaseUntilMs;
      }
      throw error;
    }
    if (session.state !== "verifying" || session.verificationToken !== verificationToken) {
      throw new VfsError("EREVISION", "upload verification lease was lost", session.path);
    }
    if (metadata === null) {
      session.state = "garbage";
      this.queueUploadGarbage(session, this.now());
      throw new VfsError("EIO", "uploaded R2 object is missing", session.path);
    }
    if (metadata.key !== session.objectKey) {
      session.state = "garbage";
      this.queueUploadGarbage(session, this.now());
      throw new VfsError("EIO", "object store returned metadata for the wrong key", session.path);
    }
    if (
      session.expectedSizeBytes !== undefined
      && metadata.sizeBytes !== session.expectedSizeBytes
    ) {
      session.state = "garbage";
      this.queueUploadGarbage(session, this.now());
      throw new VfsError("EIO", "uploaded R2 object size does not match", session.path);
    }
    if (
      options.verifiedSha256 !== undefined
      && options.verifiedSha256 !== metadata.verifiedSha256
    ) {
      session.state = "garbage";
      this.queueUploadGarbage(session, this.now());
      throw new VfsError("EINVAL", "SHA-256 was not verified by the trusted object store", session.path);
    }
    if (this.tokenFor(session.path) !== session.expectedMutationToken) {
      session.state = "garbage";
      this.queueUploadGarbage(session, this.now());
      throw new VfsError("EREVISION", "path changed after upload reservation", session.path);
    }
    const existing = this.entries.get(session.path);
    if (existing !== undefined && isDirectory(existing)) {
      session.state = "garbage";
      this.queueUploadGarbage(session, this.now());
      throw new VfsError("EISDIR", "is a directory", session.path);
    }
    const commitNow = this.now();
    this.ensureParents(
      session.path,
      session.createParents,
      commitNow,
      existing === undefined ? 1 : 0,
    );
    const objectId = this.createId();
    this.opaqueObjects.set(objectId, {
      id: objectId,
      metadata: {
        ...metadata,
        ...(session.contentType === undefined ? {} : { contentType: session.contentType }),
      },
      retainUntilMs: 0,
    });
    const token = this.bumpToken(session.path);
    const stat: OpaqueFileStat = {
      path: session.path,
      parentPath: dirname(session.path),
      name: basename(session.path),
      kind: "file",
      contentClass: "opaque",
      sizeBytes: metadata.sizeBytes,
      ...(session.contentType ?? metadata.contentType) === undefined
        ? {}
        : { contentType: session.contentType ?? metadata.contentType },
      ...(metadata.verifiedSha256 === undefined ? {} : { verifiedSha256: metadata.verifiedSha256 }),
      mode: session.mode ?? existing?.stat.mode ?? FILE_MODE,
      createdAtMs: existing?.stat.createdAtMs ?? commitNow,
      modifiedAtMs: commitNow,
      revision: existing === undefined ? 1 : existing.stat.revision + 1,
      mutationToken: token,
    };
    const previousOpaque = existing !== undefined && isOpaque(existing)
      ? existing.objectId
      : undefined;
    if (existing !== undefined && isInline(existing)) {
      this.logicalInlineBytes -= existing.stat.sizeBytes;
    }
    this.entries.set(session.path, {
      id: existing?.id ?? this.createId(),
      stat,
      objectId,
    });
    if (previousOpaque !== undefined) this.queueObjectIfUnreferenced(previousOpaque, commitNow);
    session.state = "committed";
    session.receipt = cloneStat(stat);
    session.expiresAtMs = commitNow + this.receiptRetentionMs;
    delete session.verificationToken;
    delete session.verificationLeaseUntilMs;
    return cloneStat(stat);
  }

  abortOpaqueUpload(uploadId: string): void {
    const session = this.uploads.get(uploadId);
    if (session === undefined || session.state === "garbage") return;
    if (session.state === "committed") return;
    session.state = "garbage";
    this.queueUploadGarbage(session, this.now());
  }

  resolveOpaqueRead(path: string, leaseMs = DEFAULT_READ_LEASE_MS): OpaqueReadLease {
    validatePositiveInteger(leaseMs, "leaseMs");
    const boundedLease = Math.min(leaseMs, MAX_READ_LEASE_MS);
    const normalized = this.normalizeAccessPath(path);
    const entry = this.entry(normalized);
    if (isDirectory(entry)) throw new VfsError("EISDIR", "is a directory", normalized);
    if (!isOpaque(entry)) throw new VfsError("ENOTSUP", "file is not opaque", normalized);
    const object = this.opaqueObjects.get(entry.objectId);
    if (object === undefined) throw new VfsError("EIO", "opaque object metadata is missing", normalized);
    const leaseExpiresAtMs = this.now() + boundedLease;
    object.retainUntilMs = Math.max(object.retainUntilMs, leaseExpiresAtMs);
    return {
      stat: cloneStat(entry.stat),
      object: { ...object.metadata },
      leaseExpiresAtMs,
    };
  }

  async drainGarbage(limit = 100): Promise<GarbageDrainResult> {
    validatePositiveInteger(limit, "limit");
    const store = this.opaqueStore;
    if (store === undefined) return { deleted: 0, remaining: this.garbage.size };
    const now = this.now();
    for (const session of this.uploads.values()) {
      const verificationExpired = session.state === "verifying"
        && (session.verificationLeaseUntilMs ?? 0) <= now;
      if ((session.state === "open" && session.expiresAtMs <= now) || verificationExpired) {
        session.state = "garbage";
        this.queueUploadGarbage(session, now);
      }
    }
    for (const [id, session] of this.uploads) {
      if (session.state === "committed" && session.expiresAtMs <= now) this.uploads.delete(id);
    }
    const due = [...this.garbage.values()]
      .filter((item) => item.notBeforeMs <= now && item.nextAttemptAtMs <= now)
      .sort((left, right) => left.nextAttemptAtMs - right.nextAttemptAtMs)
      .slice(0, Math.min(limit, 100));
    if (due.length === 0) return { deleted: 0, remaining: this.garbage.size };
    try {
      await store.delete(due.map((item) => item.objectKey));
      for (const item of due) {
        this.garbage.delete(item.objectKey);
        for (const [id, session] of this.uploads) {
          if (session.state === "garbage" && session.objectKey === item.objectKey) {
            this.uploads.delete(id);
          }
        }
      }
      return { deleted: due.length, remaining: this.garbage.size };
    } catch (error) {
      for (const item of due) {
        item.attempts += 1;
        item.lastError = error instanceof Error ? error.message : String(error);
        const backoff = Math.min(
          2 ** Math.min(item.attempts, 12) * 1000,
          60 * 60 * 1000,
        );
        item.nextAttemptAtMs = now + backoff;
      }
      throw error;
    }
  }
}
