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
  RemoveOptions,
  RemoveResult,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
  VirtualFileSystem,
  WriteFileOptions,
  WriteResult,
} from "../vfs/types.js";
import { textEdits } from "./edits.js";
import { type DocumentRegistry, decodeText } from "./registry.js";

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

async function bodyText(body: ByteBody, path: string): Promise<string> {
  if (typeof body === "string") return body;
  const bytes =
    body instanceof ReadableStream
      ? await readAllBytes(body, MAX_DOCUMENT_BYTES)
      : body instanceof Uint8Array
        ? body
        : ArrayBuffer.isView(body)
          ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          : new Uint8Array(body);
  return decodeText(bytes, path);
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
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
 * **A write to an open document becomes an edit.** Without this, `sed -i` on a
 * file someone is typing into is a guarded whole-file publication: it wins and
 * discards their work, or it loses with `EREVISION`. Neither is what an editor
 * wants. Routed through the document it merges, and every other holder sees it
 * as an ordinary remote change.
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

  constructor(inner: VirtualFileSystem, registry: DocumentRegistry) {
    this.#inner = inner;
    this.#registry = registry;
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
    const open = this.#registry.get(path);
    if (open === undefined || !open.dirty) return false;
    const result = await this.#inner.writeFile(path, open.document.text(), {
      ifMutationToken: open.token,
      skipIfUnchanged: true,
    });
    this.#registry.markPublished(path, result.mutationToken);
    return true;
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
    const open = this.#registry.get(path);
    if (open === undefined) return false;
    const read = this.#inner.readFile(path);
    const bytes = await readAllBytes(read.stream, MAX_DOCUMENT_BYTES);
    const edits = textEdits(open.document.text(), decodeText(bytes, path));
    if (edits.length > 0) open.document.applyExternal(edits);
    this.#registry.markPublished(path, read.stat.mutationToken);
    return edits.length > 0;
  }

  forCredentials(credentials: PosixCredentials, options?: PosixViewOptions): VirtualFileSystem {
    const candidate = this.#inner as Partial<PosixVirtualFileSystem>;
    if (typeof candidate.forCredentials !== "function") {
      throw new TypeError("the underlying filesystem does not support POSIX credentials");
    }
    return new CollaborativeFileSystem(
      candidate.forCredentials(credentials, options),
      this.#registry,
    );
  }

  /** The document holding unpublished text at `path`, if there is one. */
  #pending(path: string): { text: string } | undefined {
    const open = this.#registry.get(path);
    return open === undefined || !open.dirty ? undefined : { text: open.document.text() };
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
    const stat = this.#inner.stat(path);
    const pending = this.#pending(stat.path);
    // Reported from the same text the read would serve, so a size and its
    // bytes cannot disagree.
    return pending === undefined
      ? stat
      : { ...stat, sizeBytes: new TextEncoder().encode(pending.text).byteLength };
  }

  readFile(path: string): InlineReadResult {
    const resolved = this.#resolved(path);
    const pending = this.#pending(resolved);
    const result = this.#inner.readFile(path);
    if (pending === undefined) return result;
    // The stored snapshot is released rather than left holding in-flight
    // budget for bytes nobody is going to read.
    void result.stream.cancel();
    const bytes = new TextEncoder().encode(pending.text);
    return {
      stat: { ...result.stat, sizeBytes: bytes.byteLength },
      stream: streamOf(pending.text),
    };
  }

  async writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    const resolved = this.#resolved(path);
    const open = this.#registry.get(resolved);
    if (open === undefined) return this.#inner.writeFile(path, body, options);
    const next = await bodyText(body, resolved);
    const edits = textEdits(open.document.text(), next);
    if (edits.length === 0) {
      // The text is already what the document holds, so there is nothing to
      // merge and the write is either a publication of this very document or a
      // redundant write. Both belong in storage: swallowing them would make
      // `publishDocument` a silent no-op whenever it is handed this view
      // rather than the one underneath, which is a mistake nothing would
      // report.
      return this.#inner.writeFile(path, next, options);
    }
    open.document.applyExternal(edits);
    this.#registry.markDirty(resolved);
    // Nothing reached storage, so the revision and token are the ones already
    // there. A caller that guards on this token still guards correctly: the
    // publication that eventually happens uses it too.
    const stat = this.#inner.stat(resolved);
    return {
      path: resolved,
      revision: stat.revision,
      mutationToken: stat.mutationToken,
      sizeBytes: new TextEncoder().encode(next).byteLength,
      created: false,
    };
  }

  async appendFile(
    path: string,
    body: ByteBody,
    options?: AppendFileOptions,
  ): Promise<WriteResult> {
    const resolved = this.#resolved(path);
    const open = this.#registry.get(resolved);
    if (open === undefined) return this.#inner.appendFile(path, body, options);
    const addition = await bodyText(body, resolved);
    const text = open.document.text();
    if (addition.length > 0) {
      open.document.applyExternal([{ offset: text.length, remove: 0, insert: addition }]);
      this.#registry.markDirty(resolved);
    }
    const stat = this.#inner.stat(resolved);
    return {
      path: resolved,
      revision: stat.revision,
      mutationToken: stat.mutationToken,
      sizeBytes: new TextEncoder().encode(text + addition).byteLength,
      created: false,
    };
  }

  getMutationToken(path: string, options?: MutationTokenOptions): string {
    return this.#inner.getMutationToken(path, options);
  }

  lstat(path: string): VfsStat {
    return this.#inner.lstat(path);
  }

  readlink(path: string): string {
    return this.#inner.readlink(path);
  }

  symlink(path: string, target: string, options?: SymlinkOptions): VfsStat {
    return this.#inner.symlink(path, target, options);
  }

  realpath(path: string, options?: { follow?: boolean }): string {
    return this.#inner.realpath(path, options);
  }

  list(path: string): VfsStat[] {
    return this.#inner.list(path);
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    return this.#inner.listPage(path, options);
  }

  find(options: FindOptions): VfsStat[] {
    return this.#inner.find(options);
  }

  findPage(options: FindOptions): EntryPage {
    return this.#inner.findPage(options);
  }

  countSubtree(path: string): number {
    return this.#inner.countSubtree(path);
  }

  changesSince(since: number, options?: ChangesSinceOptions): ChangePage {
    return this.#inner.changesSince(since, options);
  }

  touch(path: string, options?: TouchOptions): VfsStat {
    return this.#inner.touch(path, options);
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    return this.#inner.setMetadata(path, options);
  }

  setOwnership(path: string, options: OwnershipUpdateOptions): VfsStat {
    return this.#inner.setOwnership(path, options);
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
    return this.#inner.beginOpaqueUpload(path, options);
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
