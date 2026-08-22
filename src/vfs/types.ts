export const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

export type ContentClass = "inline" | "opaque";
export type EntryKind = "directory" | "file" | "symlink";

/**
 * How many links one pathname resolution may follow before it is refused.
 *
 * Linux uses forty for the same reason: a cycle is indistinguishable from deep
 * nesting without a bound, and a bound that is a constant makes the refusal
 * deterministic rather than dependent on how much work the caller has already
 * done.
 */
export const MAX_SYMLINK_HOPS = 40;

/** The largest link target this filesystem stores, in UTF-8 bytes. */
export const MAX_SYMLINK_TARGET_BYTES = 4096;
export type WriteDisposition = "create" | "replace" | "upsert";

/**
 * The immutable numeric identity used for POSIX discretionary access checks.
 *
 * Names are deliberately absent: `USER`, `LOGNAME`, and any account directory
 * are presentation data supplied by the host, while authorization is based
 * only on these numeric credentials.
 */
export interface PosixCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly supplementaryGids?: readonly number[];
}

export interface PosixViewOptions {
  /** Permission bits removed from newly created entries. Defaults to `022`. */
  readonly umask?: number;
}

export interface StatBase {
  path: string;
  parentPath: string;
  name: string;
  sizeBytes: number;
  mode: number;
  uid: number;
  gid: number;
  createdAtMs: number;
  modifiedAtMs: number;
  revision: number;
  mutationToken: string;
}

export interface DirectoryStat extends StatBase {
  kind: "directory";
  contentClass: null;
}

export interface InlineFileStat extends StatBase {
  kind: "file";
  contentClass: "inline";
}

export interface OpaqueFileStat extends StatBase {
  kind: "file";
  contentClass: "opaque";
  contentType?: string;
  verifiedSha256?: string;
}

export interface SymlinkStat extends StatBase {
  kind: "symlink";
  contentClass: null;
  /** The target exactly as it was supplied, relative or absolute. */
  linkTarget: string;
}

export type VfsStat = DirectoryStat | InlineFileStat | OpaqueFileStat | SymlinkStat;

export interface PageOptions {
  cursor?: string;
  limit?: number;
}

export interface FindOptions extends PageOptions {
  path: string;
  includeRoot?: boolean;
  maxDepth?: number;
  name?: string;
  pathGlob?: string;
  type?: EntryKind;
}

export interface EntryPage {
  entries: VfsStat[];
  nextCursor: string | null;
  scanned: number;
}

export type ByteBody =
  | ReadableStream<Uint8Array>
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | string;

export interface InlineReadResult {
  stat: InlineFileStat;
  stream: ReadableStream<Uint8Array>;
}

export interface WriteFileOptions {
  createParents?: boolean;
  disposition?: WriteDisposition;
  ifRevision?: number;
  ifMutationToken?: string;
  mode?: number;
  /**
   * Publishes nothing when the body is already exactly what is stored.
   *
   * For a caller that writes a derived snapshot back into the namespace — a
   * document flushed on a timer, a rendered artifact, a mirrored file. Without
   * it, republishing identical bytes still spends a transaction and still
   * bumps the revision, which invalidates every other holder's optimistic
   * guard on that path. The churn, not the write, is what costs.
   *
   * A skipped write reports the revision and token that are already there, so
   * the caller keeps a guard it can use. Nothing else changes either:
   * `modifiedAtMs` is not advanced, no usage event is emitted, and the entry
   * keeps the identity it had.
   *
   * Everything else a write validates still applies. The disposition, the
   * revision or token guard, the directory check, and write permission are all
   * enforced first, so a stale guard fails exactly as it would have and this
   * never turns a refusal into a success.
   *
   * Only an inline body can be compared. An opaque entry is always replaced,
   * because deciding otherwise would mean reading an R2 body inside the
   * namespace transaction. A `mode` that differs from the current one also
   * writes, since the mode is part of what the call was asking for.
   */
  skipIfUnchanged?: boolean;
}

export interface AppendFileOptions {
  ifRevision?: number;
  ifMutationToken?: string;
}

export interface WriteResult {
  path: string;
  revision: number;
  mutationToken: string;
  sizeBytes: number;
  created: boolean;
}

export interface MetadataUpdateOptions {
  ifRevision?: number;
  ifMutationToken?: string;
  mode?: number;
  modifiedAtMs?: number;
}

export interface OwnershipUpdateOptions {
  ifRevision?: number;
  ifMutationToken?: string;
  uid?: number;
  gid?: number;
}

export interface TouchOptions extends MetadataUpdateOptions {
  create?: boolean;
  createParents?: boolean;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface RemoveResult {
  removed: number;
  opaqueObjectsQueuedForDeletion: number;
}

export interface MoveOptions {
  replace?: boolean;
}

export interface MoveResult {
  from: string;
  to: string;
  moved: number;
  replaced: boolean;
}

export interface CopyOptions {
  replace?: boolean;
  recursive?: boolean;
  createParents?: boolean;
  /**
   * Copies what a named link points at instead of the link.
   *
   * Off by default, and only ever applied to the named source: dereferencing a
   * whole subtree would turn every link in it into another copy of its target,
   * which is unbounded work behind an option that reads as a detail.
   */
  dereference?: boolean;
}

export interface CopyResult {
  from: string;
  to: string;
  copied: number;
  replaced: boolean;
  opaqueBodiesCopied: 0;
}

export type ByteRange =
  | { readonly offset: number; readonly length?: number; readonly suffix?: never }
  | { readonly offset?: number; readonly length: number; readonly suffix?: never }
  | { readonly offset?: never; readonly length?: never; readonly suffix: number };

export interface OpaqueObjectMetadata {
  key: string;
  sizeBytes: number;
  etag: string;
  version: string;
  contentType?: string;
  verifiedSha256?: string;
}

export interface OpaqueStore {
  putIfAbsent(
    key: string,
    body: ByteBody,
    metadata?: { contentType?: string },
  ): Promise<OpaqueObjectMetadata>;
  head(key: string): Promise<OpaqueObjectMetadata | null>;
  getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  delete(keys: string | readonly string[]): Promise<void>;
}

export interface BeginOpaqueUploadOptions {
  createParents?: boolean;
  ifMutationToken?: string;
  mode?: number;
  expectedSizeBytes?: number;
  expiresInMs?: number;
  contentType?: string;
}

export interface OpaqueUploadReservation {
  uploadId: string;
  path: string;
  objectKey: string;
  expectedMutationToken: string;
  expiresAtMs: number;
  contentType?: string;
}

export interface CommitOpaqueUploadOptions {
  verifiedSha256?: string;
}

export interface OpaqueReadLease {
  stat: OpaqueFileStat;
  object: OpaqueObjectMetadata;
  leaseExpiresAtMs: number;
}

export interface GarbageDrainResult {
  deleted: number;
  remaining: number;
}

export interface SymlinkOptions {
  createParents?: boolean;
  ifMutationToken?: string;
  /** Replaces an existing link or file at the path rather than failing. */
  replace?: boolean;
}

export interface MutationTokenOptions {
  /**
   * Reads the token of the link itself rather than of what it points at.
   *
   * The default follows, so a token pairs with the write that would use it:
   * `writeFile` resolves the path, and a guard read from the unresolved one
   * would be a version of a different row and never match. Pass `false` when
   * the guarded change is to the link — replacing it with `symlink`.
   */
  follow?: boolean;
}

export interface VirtualFileSystem {
  getMutationToken(path: string, options?: MutationTokenOptions): string;
  /** Resolves symbolic links in every component, as `stat(2)` does. */
  stat(path: string): VfsStat;
  /**
   * Resolves symbolic links in every component except the last, as `lstat(2)`
   * does, so a link is reported as itself rather than as what it points at.
   */
  lstat(path: string): VfsStat;
  /** Returns the target of a symbolic link exactly as it was supplied. */
  readlink(path: string): string;
  /**
   * Creates a symbolic link at `path` holding `target` verbatim.
   *
   * The target is not resolved, checked, or required to exist: a dangling link
   * is a valid link, and refusing to create one would make the order in which a
   * caller restores a tree significant.
   */
  symlink(path: string, target: string, options?: SymlinkOptions): VfsStat;
  /**
   * Canonicalizes a path by resolving every symbolic link in it.
   *
   * A final component that does not exist is kept rather than refused, so a
   * caller can canonicalize the destination of a write it has not made yet.
   * This is the single place link resolution happens, which is what keeps a
   * policy check or a loop bound from being bypassed by a new caller.
   */
  realpath(path: string, options?: { follow?: boolean }): string;
  list(path: string): VfsStat[];
  listPage(path: string, options?: PageOptions): EntryPage;
  find(options: FindOptions): VfsStat[];
  findPage(options: FindOptions): EntryPage;
  /**
   * Counts the entries at and below `path`, including `path` itself, with one
   * indexed range query. Unlike `find()` this materializes no `VfsStat` and has
   * no result ceiling, so it stays correct and constant-cost for a subtree of
   * any size.
   */
  countSubtree(path: string): number;
  readFile(path: string): InlineReadResult;
  writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult>;
  appendFile(path: string, body: ByteBody, options?: AppendFileOptions): Promise<WriteResult>;
  touch(path: string, options?: TouchOptions): VfsStat;
  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat;
  setOwnership(path: string, options: OwnershipUpdateOptions): VfsStat;
  mkdir(path: string, recursive?: boolean, mode?: number): VfsStat;
  remove(path: string, options?: RemoveOptions): Promise<RemoveResult>;
  move(from: string, to: string, options?: MoveOptions): Promise<MoveResult>;
  copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult>;
  beginOpaqueUpload(
    path: string,
    options?: BeginOpaqueUploadOptions,
  ): Promise<OpaqueUploadReservation>;
  commitOpaqueUpload(
    uploadId: string,
    options?: CommitOpaqueUploadOptions,
  ): Promise<OpaqueFileStat>;
  abortOpaqueUpload(uploadId: string): Promise<void>;
  resolveOpaqueRead(path: string, leaseMs?: number): OpaqueReadLease;
  drainGarbage(limit?: number): Promise<GarbageDrainResult>;
}

/**
 * A filesystem capable of producing an immutable per-user access-controlled
 * view. The raw `VirtualFileSystem` remains the trusted administration
 * capability; shells bind this view only when the host supplies credentials.
 */
export interface PosixVirtualFileSystem extends VirtualFileSystem {
  forCredentials(credentials: PosixCredentials, options?: PosixViewOptions): VirtualFileSystem;
}
