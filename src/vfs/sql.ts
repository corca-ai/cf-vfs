import { VfsError } from "../core/errors.js";
import { SqlGc } from "./sql-gc-base.js";
import {
  type PosixAccessContext,
  type PosixMutationOperation,
  posixContext,
  posixPermissions,
  READ_PERMISSION,
} from "./sql-posix.js";
import type {
  AppendFileOptions,
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
