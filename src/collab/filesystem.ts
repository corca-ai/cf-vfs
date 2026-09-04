import { VfsError } from "../core/errors.js";
import { isDescendant, normalizePath } from "../core/path.js";
import { encodeUtf8, utf8ByteLength } from "../core/unicode.js";
import { supportsPosixCredentials } from "../vfs/capabilities.js";
import { sha256Hex } from "../vfs/digest.js";
import { byteRangeBounds } from "../vfs/range.js";
import { readAllBytes } from "../vfs/streams.js";
import type {
  AppendFileOptions,
  BeginOpaqueUploadOptions,
  ByteBody,
  ChangePage,
  ChangesSinceOptions,
  CommitOpaqueUploadOptions,
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
} from "../vfs/types.js";
import { DocumentOperations } from "./operations.js";
import type { DocumentRegistry } from "./registry.js";
import type { OpenDocument } from "./types.js";

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

function streamOf(body: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof body === "string" ? encodeUtf8(body) : body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * A filesystem that routes reads and writes of open documents through them.
 *
 * Two rules, and the second is the one worth understanding.
 *
 * **A write to an open document becomes an edit.** Read/modify/write callers
 * use the token from this view, which covers the document version as well as
 * storage. A stale write fails with EREVISION and preserves pending edits.
 * Unguarded writes explicitly replace the current text. Reconciliation merges
 * disjoint changes from a common base and reports overlaps to the host.
 *
 * **A read of an open document sees what has not been published yet.**
 * Flushing before an execution is not enough on its own, because a write
 * *during* the execution leaves the document ahead of storage — `sed -i`
 * followed by `cat` in one script is enough to show it. Serving reads from the
 * document is what keeps `grep` answering about the file the user can see.
 *
 * Everything else delegates untouched, including `forCredentials`, so a
 * credential-bound view is still bound and still collaborative.
 */
export class CollaborativeFileSystem implements PosixVirtualFileSystem {
  readonly #inner: VirtualFileSystem;
  readonly #registry: DocumentRegistry;
  readonly #documents: DocumentOperations;

  constructor(inner: VirtualFileSystem, registry: DocumentRegistry) {
    this.#inner = inner;
    this.#registry = registry;
    this.#documents = new DocumentOperations(inner, registry);
  }

  /**
   * Writes an open document back to the namespace, guarded by the token it was
   * read at.
   *
   * A method rather than a function taking a filesystem, because there are two
   * filesystems here and only one of them is right: publishing through the
   * collaborative view would be turned back into an edit of the very document
   * being published, and reading through it would compare a document against
   * itself. Owning both sides is what makes passing the wrong one impossible
   * rather than silently ineffective.
   *
   * `skipIfUnchanged` keeps a timer-driven flush from churning: an unchanged
   * publication still bumps the revision and invalidates every other holder's
   * guard on that path. `EREVISION` means the namespace moved underneath —
   * reconcile and try again rather than overwrite.
   */
  async publish(path: string): Promise<boolean> {
    return this.#documents.publish(path);
  }

  /**
   * Brings an open document up to date with what the namespace holds.
   *
   * For a change the document did not make — another caller, a restored file.
   * Compare a notification's token against the one the registry reports first:
   * they match when the change was this view's own publication, and
   * reconciling against that is work with no result.
   */
  async reconcile(path: string): Promise<boolean> {
    return this.#documents.reconcile(path);
  }

  forCredentials(credentials: PosixCredentials, options?: PosixViewOptions): VirtualFileSystem {
    if (!supportsPosixCredentials(this.#inner)) {
      throw new TypeError("the underlying filesystem does not support POSIX credentials");
    }
    return new CollaborativeFileSystem(
      this.#inner.forCredentials(credentials, options),
      this.#registry,
    );
  }

  /** The document holding unpublished text at `path`, if there is one. */
  #pending(path: string): { text: string } | undefined {
    const open = this.#registry.get(path);
    return open === undefined || !open.dirty ? undefined : { text: open.document.text() };
  }

  #metadataResult(path: string, open: OpenDocument | undefined, stat: VfsStat): VfsStat {
    const current = this.#registry.get(path);
    if (open !== undefined && current?.document === open.document) {
      this.#registry.recordMetadata(path, open, stat.mutationToken);
    }
    return this.#withPendingSize(stat);
  }

  #metadataSnapshot(path: string): OpenDocument | undefined {
    const open = this.#registry.get(path);
    // A metadata update acknowledges only a base this document already knows.
    // Otherwise advancing its guard would authorize overwriting unseen content.
    return open !== undefined && open.token === this.#inner.getMutationToken(path)
      ? open
      : undefined;
  }

  #withPendingSize<Stat extends VfsStat>(stat: Stat): Stat {
    const pending = this.#pending(stat.path);
    return {
      ...stat,
      sizeBytes: pending === undefined ? stat.sizeBytes : utf8ByteLength(pending.text),
      mutationToken: this.#registry.mutationToken(stat.path, stat.mutationToken),
    };
  }

  /**
   * Resolves before looking the document up, because a document is keyed by
   * the path it lives at and a caller may have named a link to it.
   *
   * Free in a namespace with no links, which is the condition the resolver is
   * built to make cheap.
   */
  #resolved(path: string): string {
    try {
      return this.#inner.realpath(path);
    } catch {
      return path;
    }
  }

  stat(path: string): VfsStat {
    // Reported from the same text the read would serve, so a size and its
    // bytes cannot disagree.
    return this.#withPendingSize(this.#inner.stat(path));
  }

  statById(ino: number): VfsStat {
    // Same correction as `stat`, and for the same reason: an identity is how a
    // caller finds a document it is holding, so the size it reports has to be
    // the size the read would serve rather than the one last published.
    return this.#withPendingSize(this.#inner.statById(ino));
  }

  readFile(path: string, options?: ReadFileOptions): InlineReadResult {
    const resolved = this.#resolved(path);
    const pending = this.#pending(resolved);
    const result = this.#inner.readFile(path, options);
    if (pending === undefined) return { ...result, stat: this.#withPendingSize(result.stat) };
    // The stored snapshot is released rather than left holding in-flight
    // budget for bytes nobody is going to read.
    void result.stream.cancel();
    const bytes = encodeUtf8(pending.text);
    const selected = byteRangeBounds(options?.range, bytes.byteLength, resolved);
    return {
      stat: this.#withPendingSize({ ...result.stat, sizeBytes: bytes.byteLength }),
      stream: streamOf(bytes.subarray(selected.offset, selected.offset + selected.length)),
    };
  }

  async digestFile(path: string): Promise<string> {
    const resolved = this.#resolved(path);
    if (this.#pending(resolved) === undefined) return this.#inner.digestFile(path);
    const read = this.readFile(path);
    const bytes = await readAllBytes(read.stream, MAX_DOCUMENT_BYTES);
    return sha256Hex([bytes], bytes.byteLength);
  }

  async writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    return this.#documents.write(path, body, options);
  }

  /**
   * Refuses a batch that touches an open document, and delegates every other.
   *
   * `writeFiles` promises that a failed set leaves every path as it was, and
   * that promise rests on one SQLite transaction. An open document does not
   * live in that transaction: a write to it lands in the registry, is
   * published later, and can fail on its own. A set spanning both stores could
   * commit the storage half and lose the document half, which is precisely
   * what the batch exists to rule out.
   *
   * Publishing first is *not* the way around it. `publish` records the token
   * and clears the dirty flag; it does not close the document, so the path is
   * still open and still refused -- and it should be, because a read of an
   * open document is served from the document. A batch that wrote underneath
   * one would be followed by a `cat` returning the document's older text with
   * nothing reporting the disagreement.
   *
   * Two routes work. Either `close` the document, run the batch, and reopen at
   * the token the batch published; or run the batch against the filesystem
   * underneath this one and `reconcile` each open document afterwards, which
   * is what `reconcile` is for -- a change the document did not make.
   *
   * The check runs before any body is collected, so a document opened during
   * collection is not seen and the batch commits underneath it. The registry
   * is the host's to drive, so that ordering is the host's too: open and close
   * documents around a batch, not during one.
   */
  async writeFiles(
    entries: readonly WriteFilesEntry[],
    options?: WriteFilesOptions,
  ): Promise<WriteResult[]> {
    for (const entry of entries) {
      const resolved = this.#resolved(entry.path);
      if (this.#registry.get(resolved) !== undefined) {
        throw new VfsError(
          "ENOTSUP",
          "a batch write cannot include an open document; publish it first",
          resolved,
        );
      }
    }
    return this.#inner.writeFiles(entries, options);
  }

  async appendFile(
    path: string,
    body: ByteBody,
    options?: AppendFileOptions,
  ): Promise<WriteResult> {
    return this.#documents.write(path, body, { ...options, disposition: "replace" }, true);
  }

  getMutationToken(path: string, options?: MutationTokenOptions): string {
    return this.#documents.token(path, options);
  }

  lstat(path: string): VfsStat {
    return this.#withPendingSize(this.#inner.lstat(path));
  }

  readlink(path: string): string {
    return this.#inner.readlink(path);
  }

  symlink(path: string, target: string, options?: SymlinkOptions): VfsStat {
    return this.#inner.symlink(
      path,
      target,
      this.#documents.storageOptions(path, options ?? {}, false),
    );
  }

  realpath(path: string, options?: { follow?: boolean }): string {
    return this.#inner.realpath(path, options);
  }

  list(path: string): VfsStat[] {
    return this.#inner.list(path).map((entry) => this.#withPendingSize(entry));
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    const page = this.#inner.listPage(path, options);
    return { ...page, entries: page.entries.map((entry) => this.#withPendingSize(entry)) };
  }

  find(options: FindOptions): VfsStat[] {
    return this.#inner.find(options).map((entry) => this.#withPendingSize(entry));
  }

  findPage(options: FindOptions): EntryPage {
    const page = this.#inner.findPage(options);
    return { ...page, entries: page.entries.map((entry) => this.#withPendingSize(entry)) };
  }

  subtreeSummary(path: string): SubtreeSummary {
    const summary = this.#inner.subtreeSummary(path);
    const openPaths = this.#registry.paths();
    if (openPaths.length === 0) return summary;
    const root = this.#inner.lstat(path);
    if (root.kind === "symlink") return summary;
    const normalized = normalizePath(root.path);
    let logicalFileBytes = summary.logicalFileBytes;
    for (const candidate of openPaths) {
      if (candidate !== normalized && !isDescendant(normalized, candidate)) continue;
      const pending = this.#pending(candidate);
      if (pending === undefined) continue;
      const stored = this.#inner.stat(candidate);
      logicalFileBytes += utf8ByteLength(pending.text) - stored.sizeBytes;
    }
    return { ...summary, logicalFileBytes };
  }

  changesSince(since: number, options?: ChangesSinceOptions): ChangePage {
    return this.#inner.changesSince(since, options);
  }

  touch(path: string, options?: TouchOptions): VfsStat {
    const resolved = this.#resolved(path);
    const open = this.#metadataSnapshot(resolved);
    return this.#metadataResult(
      resolved,
      open,
      this.#inner.touch(path, this.#documents.storageOptions(path, options ?? {})),
    );
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    const resolved = this.#resolved(path);
    const open = this.#metadataSnapshot(resolved);
    return this.#metadataResult(
      resolved,
      open,
      this.#inner.setMetadata(path, this.#documents.storageOptions(path, options)),
    );
  }

  setOwnership(path: string, options: OwnershipUpdateOptions): VfsStat {
    const resolved = this.#resolved(path);
    const open = this.#metadataSnapshot(resolved);
    return this.#metadataResult(
      resolved,
      open,
      this.#inner.setOwnership(path, this.#documents.storageOptions(path, options)),
    );
  }

  mkdir(path: string, recursive?: boolean, mode?: number): VfsStat {
    return this.#inner.mkdir(path, recursive, mode);
  }

  remove(path: string, options?: RemoveOptions): Promise<RemoveResult> {
    return this.#inner.remove(path, options);
  }

  move(from: string, to: string, options?: MoveOptions): Promise<MoveResult> {
    return this.#inner.move(from, to, options);
  }

  copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult> {
    return this.#inner.copy(from, to, options);
  }

  beginOpaqueUpload(
    path: string,
    options?: BeginOpaqueUploadOptions,
  ): Promise<OpaqueUploadReservation> {
    return this.#inner.beginOpaqueUpload(path, this.#documents.storageOptions(path, options ?? {}));
  }

  commitOpaqueUpload(
    uploadId: string,
    options?: CommitOpaqueUploadOptions,
  ): Promise<OpaqueFileStat> {
    return this.#inner.commitOpaqueUpload(uploadId, options);
  }

  abortOpaqueUpload(uploadId: string): Promise<void> {
    return this.#inner.abortOpaqueUpload(uploadId);
  }

  resolveOpaqueRead(path: string, leaseMs?: number): OpaqueReadLease {
    return this.#inner.resolveOpaqueRead(path, leaseMs);
  }

  drainGarbage(limit?: number): Promise<GarbageDrainResult> {
    return this.#inner.drainGarbage(limit);
  }
}
