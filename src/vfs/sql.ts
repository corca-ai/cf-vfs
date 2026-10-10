import { VfsError } from "../core/errors.js";
import { createHandleProvider, type HandleProvider, type SqlHandlePort } from "./handle-port.js";
import { SqlGc } from "./sql-gc-base.js";
import { type EntryRow, rowToStat } from "./sql-model.js";
import {
  type PosixAccessContext,
  type PosixMutationOperation,
  posixContext,
  posixPermissions,
  READ_PERMISSION,
  WRITE_PERMISSION,
} from "./sql-posix.js";
import type {
  AppendFileOptions,
  BulkOperation,
  ByteBody,
  ChangePage,
  CopyOptions,
  CopyResult,
  EntryPage,
  FindOptions,
  GarbageDrainResult,
  InlineReadResult,
  MetadataUpdateOptions,
  MoveOptions,
  MoveResult,
  MutationTokenOptions,
  OpaqueFileStat,
  OpaqueReadLease,
  OpaqueUploadReservation,
  OwnershipUpdateOptions,
  PageOptions,
  PosixCredentials,
  PosixViewOptions,
  PosixVirtualFileSystem,
  ReadFileOptions,
  RemoveOptions,
  RemoveResult,
  SubtreeSummary,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
  VirtualFileSystem,
  WriteFileOptions,
  WriteFilesEntry,
  WriteFilesOptions,
  WriteResult,
} from "./types.js";

export type {
  SqlFileSystemOptions,
  SqlFileSystemStorage,
  VfsSqlBinding,
  VfsSqlCursor,
  VfsSqlRow,
  VfsSqlStorage,
} from "./sql-model.js";

export class SqlFileSystem extends SqlGc implements PosixVirtualFileSystem {
  private handles: HandleProvider | undefined;
  canUseBulkOperation(_operation: BulkOperation, _path: string): boolean {
    return true;
  }

  /** Hosts await this at startup to arm recovery maintenance before serving work. */
  async initialize(): Promise<void> {
    if (!this.recoveredDetached) return;
    await this.scheduleGarbageAlarm();
    this.recoveredDetached = false;
  }
  openFileHandle(path: string, flags = "r", mode = 0o666, access?: PosixAccessContext) {
    this.handles ??= createHandleProvider(this.handlePort());
    return this.handles.open(path, flags, mode, access);
  }
  linkFile(from: string, to: string, access?: PosixAccessContext): void {
    this.handles ??= createHandleProvider(this.handlePort());
    this.handles.link(from, to, access);
  }
  private handlePort(): SqlHandlePort {
    return {
      sql: this.sql,
      batch: (query) => this.execBatch(query),
      linked: () => {
        this.sharedInodes = true;
      },
      sourceEntry: (path, access) => {
        const resolved = this.resolveAccess(path, false, false);
        this.assertTraverse(resolved.path, resolved.followed, access);
        return resolved.row ?? this.requireEntry(resolved.path, false);
      },
      budget: this.inFlightBytes,
      chunkBytes: this.chunkBytes,
      maximum: this.maxInlineFileBytes,
      store: this.opaqueStore,
      transaction: (callback) => this.transaction(callback),
      now: () => this.now(),
      openEntry: (...args) => this.openHandleEntry(...args),
      retain: (callback) => {
        this.retainOpenInodes = callback;
      },
      capacity: (delta, path) => this.assertCapacity(delta, 0, path),
      usage: (delta) => this.updateUsage(delta, 0),
      publish: (entry) => {
        this.publishToken(entry.path, entry.mutationVersion, true, "write", entry);
      },
      reclaimObject: (id) => {
        this.queueObjectIfUnreferenced(id, this.now());
      },
      sync: () => this.storage.sync?.() ?? Promise.resolve(),
      maintenance: () => this.scheduleGarbageAlarm(),
      stat: rowToStat,
    };
  }
  private openHandleEntry(
    path: string,
    read: boolean,
    write: boolean,
    create: boolean,
    exclusive: boolean,
    mode: number,
    access?: PosixAccessContext,
  ): EntryRow {
    if (exclusive) {
      const named = this.resolveAccess(path, false, false);
      if ((named.row ?? this.oneEntry(named.path)) !== null)
        throw new VfsError("EEXIST", "entry exists", path);
    }
    const resolved = this.resolveAccess(path);
    this.assertTraverse(resolved.path, resolved.followed, access);
    let entry = resolved.row ?? this.oneEntry(resolved.path);
    const created = entry === null && create;
    if (created) {
      this.touch(path, { mode: 0o100000 | (mode & 0o7777) }, access);
      entry = this.requireEntry(resolved.path);
    }
    if (entry === null) throw new VfsError("ENOENT", "file does not exist", path);
    if (entry.kind !== "file") throw new VfsError("EISDIR", "not a regular file", path);
    if (!created)
      this.assertPermission(
        entry,
        access,
        (read ? READ_PERMISSION : 0) | (write ? WRITE_PERMISSION : 0),
        path,
      );
    return entry;
  }
  forCredentials(credentials: PosixCredentials, options: PosixViewOptions = {}): VirtualFileSystem {
    return new PosixFileSystemView(this, posixContext(credentials, options));
  }
}

/** Immutable credential-bound view over the shared SQL engine. */
class PosixFileSystemView implements VirtualFileSystem {
  constructor(
    private readonly inner: SqlFileSystem,
    private readonly access: PosixAccessContext,
  ) {}

  canUseBulkOperation(operation: BulkOperation, path: string): boolean {
    return this.inner.canUseBulkOperation(operation, path);
  }

  linkFile(from: string, to: string): void {
    this.inner.linkFile(from, to, this.access);
  }

  openFileHandle(path: string, flags = "r", mode = 0o666) {
    return this.inner.openFileHandle(path, flags, mode, this.access);
  }

  getMutationToken(path: string, options?: MutationTokenOptions): string {
    return this.inner.getMutationToken(path, options, this.access);
  }

  get availableWriteBufferBytes(): number {
    return this.inner.availableWriteBufferBytes;
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

  subtreeSummary(path: string): SubtreeSummary {
    return this.inner.subtreeSummary(path, this.access);
  }

  mutationSubtreeCount(path: string, operation: PosixMutationOperation): number {
    return this.inner.countPosixMutationSubtree(path, operation, this.access);
  }

  digestFile(path: string): Promise<string> {
    return this.inner.digestFile(path, this.access);
  }

  readFile(path: string, options?: ReadFileOptions): InlineReadResult {
    return this.inner.readFile(path, options, this.access);
  }

  validateInlineWrite(
    path: string,
    options?: WriteFileOptions,
    sizeBytes?: number,
    additionalInlineBytes?: number,
  ): number {
    return this.inner.validateInlineWrite(
      path,
      options,
      sizeBytes,
      additionalInlineBytes,
      this.access,
    );
  }

  writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    return this.inner.writeFile(path, body, options, this.access);
  }

  writeFiles(
    entries: readonly WriteFilesEntry[],
    options?: WriteFilesOptions,
  ): Promise<WriteResult[]> {
    // An ordinary write, so it is offered here like one. Every per-entry
    // permission check the single-path form performs runs unchanged, because
    // both forms run the same planning and the same commit.
    return this.inner.writeFiles(entries, options, this.access);
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

  statById(): VfsStat {
    // Identities are dense consecutive integers, so a view that answers by one
    // lets any credential enumerate the workspace by counting up from 1 --
    // existence and cardinality for entries it cannot reach, and their paths.
    // Filtering cannot fix it: reporting an unreadable entry as absent is a lie
    // a caller acts on, and refusing only those still leaks by bisection.
    // POSIX declines to open by inode rather than permission-checking it.
    throw new VfsError("EPERM", "user views cannot read by entry identity");
  }

  changesSince(): ChangePage {
    // The feed names paths without regard to what this user can see, so it
    // stays with the trusted capability rather than being filtered here into
    // something that looks like a per-user view and is not one.
    throw new VfsError("EPERM", "user views cannot read the workspace change feed");
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
