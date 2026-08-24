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
  /**
   * The entry's identity, in the position `st_ino` holds.
   *
   * Stable for as long as the entry is. Every way of replacing the content at
   * a path keeps it — a write, an append, and a copy of one file over another
   * — and so does a move, which renames the path and carries the entry with
   * it. What ends an identity is the entry going away: a removal, a move that
   * replaces the destination, or a copy over anything that is not a file
   * whose content was rewritten. Once ended, the number is **never handed out
   * again** — POSIX permits an
   * implementation to recycle inode numbers and this one does not, because a
   * recycled identity silently reattaches whatever a caller keyed to the old
   * file while an absent one is known to be unusable.
   *
   * Unique among the entries of one workspace, and meaningless across two. It
   * is the `st_ino` half of POSIX identity; there is no `st_dev`, because a
   * Durable Object is the device.
   *
   * **Zero means there is no entry.** A shell device such as `/dev/null` and a
   * reserved applet directory such as `/bin` are answered above the namespace
   * and have no row, so they all report zero and share it with each other. No
   * real entry ever does — identities are issued from one — but a caller
   * keying durable state to `ino` has to exclude them, or two device paths
   * become one key. Use `hasEntryIdentity()` rather than comparing against
   * zero by hand.
   *
   * It does not make hard links expressible. A hard link is two names for one
   * entry, which this namespace forbids in its shape rather than for want of
   * an identity: a path is unique and an entry stores the one it lives at.
   */
  ino: number;
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

/**
 * The identity reported for a path that has no entry behind it.
 *
 * Shared by every shell device and reserved applet directory, and never held
 * by a real entry. It is a legal `st_ino` value rather than a null so a caller
 * that never touches `/dev` is not made to handle one.
 */
export const NO_ENTRY_IDENTITY = 0;

/**
 * Whether a stat describes an entry, and so whether its `ino` identifies one.
 *
 * The check the sentinel exists for, written once. A host mapping `ino` to a
 * per-file room, a grant, or an index row should ask this first: without it,
 * `/dev/null` and `/bin` arrive as the same key.
 */
export function hasEntryIdentity(stat: VfsStat): boolean {
  return stat.ino !== NO_ENTRY_IDENTITY;
}

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

/** One path whose content, metadata, or existence changed. */
export interface WorkspaceChange {
  readonly path: string;
  /**
   * Whether anything is at the path now.
   *
   * `false` covers removal and the source side of a move, which are the same
   * fact to a caller holding a view: nothing is there any more.
   */
  readonly present: boolean;
}

export interface ChangePage {
  readonly changes: WorkspaceChange[];
  /** The sequence to resume from, whether or not anything changed. */
  readonly cursor: number;
  /** Set when a limit ended the page and another call returns more. */
  readonly more: boolean;
}

export interface ChangesSinceOptions {
  limit?: number;
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
  /**
   * Refuses the call unless nothing has changed the path since the token was
   * taken. The value comes from any `stat`, write result, or
   * `getMutationToken`, so a caller never needs an extra read to hold one.
   *
   * This is the only guard the library offers, because it is the only one that
   * can be sound. It composes the workspace epoch with the version of every
   * path crossed on the way, and `vfs_path_versions` retains a version as a
   * tombstone while its path is absent -- so a path that was removed and
   * recreated, or repointed at a different file through a link, fails it. A
   * number carried on the entry row can express none of that: the row is
   * destroyed by a removal, and nothing on it records that the path became a
   * link. `revision` remains on every result as an observable, for display,
   * logging, and cheap change detection; it is not a precondition.
   *
   * It is not path-qualified. Two paths at the same version compose the same
   * token, so it answers "has anything at this version changed" rather than
   * "has this path changed" -- take the token from the path being guarded.
   */
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
   * Deciding it reads the stored body once and then records a digest of it, so
   * the entry answers later calls without being read again and the cost stops
   * following the body's size. The digest is internal -- it is never reported,
   * never accepted, and stamped with the revision it was taken at, so any
   * change to the content retires it.
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
  /** See {@link WriteFileOptions.ifMutationToken}. */
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
  /** See {@link WriteFileOptions.ifMutationToken}. */
  ifMutationToken?: string;
  mode?: number;
  modifiedAtMs?: number;
}

export interface OwnershipUpdateOptions {
  /** See {@link WriteFileOptions.ifMutationToken}. */
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
   * Reports the entry holding an identity, so a caller that keyed durable
   * state to one can find where it is now.
   *
   * `ino` is otherwise write-only: it comes out of every `stat`, `list` and
   * `find`, and nothing takes one back. A host that keyed a room, a grant or an
   * index row to an entry can follow it through a move, a rename and a content
   * replace, but has no way to turn what it is holding back into a path, or to
   * learn that the entry is gone.
   *
   * Reports the entry itself, never what it points at: an identity names a row,
   * so a link resolves to the link the way `lstat` does. `ENOENT` for an
   * identity no entry holds, which is permanent — identities are never reissued
   * — and `EINVAL` for one that was never issuable.
   *
   * Absent from the credential-bound view, which refuses it with `EPERM`.
   * Identities are dense consecutive integers, so a caller that may read by one
   * can enumerate the workspace by counting; `list` and `find` are safe under
   * credentials partly because reaching a path means knowing its name, and
   * reaching an identity means adding one. POSIX declines to open by inode for
   * the same reason rather than permission-checking it.
   */
  statById(ino: number): VfsStat;
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
  /**
   * Reports every path that changed after `since`, for a caller that was away.
   *
   * Requires `recordChanges`. It answers what a mutation token cannot: a token
   * says whether one path a caller already names has changed, never which
   * paths did.
   *
   * `since = 0` reports everything that changed after recording was enabled,
   * not the whole namespace — paths that predate it are not invented. A caller
   * with no state therefore **takes a cursor first and reads the namespace
   * second**: anything that changes during that read carries a later sequence
   * and is replayed on the next call. Reading first and taking a cursor after
   * would lose whatever happened in between.
   *
   * The feed is collapsed rather than a log: one entry per path however many
   * times it changed, holding what is true now. That is what a caller
   * rebuilding a view wants, and it is why the history costs one column on
   * rows that already exist rather than a row per change.
   *
   * A rename therefore arrives as an absent path and a present one, with
   * nothing pairing them — the live `vfs.mutation` event expresses a move and
   * this cannot. A caller that must follow a document across a rename it did
   * not observe has to record moves itself while it is connected.
   *
   * Not available on a credential-bound view: the feed reports paths without
   * regard to what a user can see.
   */
  changesSince(since: number, options?: ChangesSinceOptions): ChangePage;
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
