import { VfsError } from "../core/errors.js";
import { utf8ByteLength } from "../core/unicode.js";
import { readAllBytes } from "../vfs/streams.js";
import type {
  ByteBody,
  InlineWriteValidator,
  MutationTokenOptions,
  VirtualFileSystem,
  WriteFileOptions,
  WriteResult,
} from "../vfs/types.js";
import { textEdits } from "./edits.js";
import { mergeText } from "./merge.js";
import { type DocumentRegistry, decodeText } from "./registry.js";
import type { OpenDocument } from "./types.js";

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
function validator(inner: VirtualFileSystem): InlineWriteValidator {
  const candidate = inner as VirtualFileSystem & Partial<InlineWriteValidator>;
  if (typeof candidate.validateInlineWrite !== "function")
    throw new VfsError("ENOTSUP", "deferred writes require backend write validation");
  return { validateInlineWrite: candidate.validateInlineWrite.bind(inner) };
}

/** Document coordination is separate from the filesystem's forwarding surface. */
export class DocumentOperations {
  constructor(
    private readonly inner: VirtualFileSystem,
    private readonly registry: DocumentRegistry,
  ) {}

  token(path: string, options?: MutationTokenOptions): string {
    const raw = this.inner.getMutationToken(path, options);
    return this.registry.mutationToken(this.inner.realpath(path, options), raw);
  }

  storageOptions<T extends { ifMutationToken?: string }>(
    path: string,
    options: T,
    follow = true,
  ): T {
    if (options.ifMutationToken === undefined) return options;
    if (options.ifMutationToken !== this.token(path, { follow }))
      throw new VfsError("EREVISION", "document mutation token does not match", path);
    return { ...options, ifMutationToken: this.inner.getMutationToken(path, { follow }) };
  }

  private unchanged(path: string, snapshot: OpenDocument, text: string): void {
    const current = this.registry.get(path);
    if (
      !this.registry.isUnchanged(path, snapshot) ||
      current?.version !== snapshot.version ||
      current.document.text() !== text
    )
      throw new VfsError("EREVISION", "document changed while the operation was pending", path);
  }

  async publish(path: string): Promise<boolean> {
    if (this.registry.get(path)?.needsRefresh) await this.reconcile(path);
    const open = this.registry.get(path);
    if (open === undefined || !open.dirty) return false;
    const text = open.document.text();
    const result = await this.inner.writeFile(path, text, {
      ifMutationToken: open.token,
      skipIfUnchanged: true,
    });
    this.registry.recordStored(path, open, text, result.mutationToken);
    return true;
  }

  async reconcile(path: string): Promise<boolean> {
    const open = this.registry.get(path);
    if (open === undefined) return false;
    const before = open.document.text();
    const read = this.inner.readFile(path);
    const bytes = await readAllBytes(read.stream, MAX_DOCUMENT_BYTES);
    if (!this.registry.isUnchanged(path, open)) return false;
    this.unchanged(path, open, before);
    if (this.inner.getMutationToken(path) !== read.stat.mutationToken)
      throw new VfsError("EREVISION", "stored document changed during reconciliation", path);
    const incoming = decodeText(bytes, path);
    const edits = textEdits(before, mergeText(open.publishedText, before, incoming));
    if (edits.length > 0) {
      open.document.applyExternal(edits);
      this.registry.markDirty(path);
    }
    this.registry.recordStored(path, open, incoming, read.stat.mutationToken);
    return edits.length > 0;
  }

  async write(
    path: string,
    body: ByteBody,
    options: WriteFileOptions = {},
    append = false,
  ): Promise<WriteResult> {
    const resolved = this.inner.realpath(path);
    const open = this.registry.get(resolved);
    if (open === undefined)
      return append
        ? this.inner.appendFile(path, body, options)
        : this.inner.writeFile(path, body, options);
    const before = open.document.text();
    const checked = this.storageOptions(path, options);
    const storageOptions = { ...checked, ifMutationToken: this.inner.getMutationToken(path) };
    const validation = validator(this.inner);
    validation.validateInlineWrite(path, storageOptions);
    const incoming = await bodyText(body, resolved);
    // A closed document can be delegated only if it was not replaced by another registration.
    if (this.registry.get(resolved) === undefined)
      return append
        ? this.inner.appendFile(path, incoming, storageOptions)
        : this.inner.writeFile(path, incoming, storageOptions);
    this.unchanged(resolved, open, before);
    const next = append ? before + incoming : incoming;
    const mode = validation.validateInlineWrite(
      path,
      storageOptions,
      utf8ByteLength(next),
      this.registry.pendingGrowth(resolved),
    );
    return this.applyWrite(path, resolved, open, next, mode, storageOptions, append);
  }

  private async applyWrite(
    path: string,
    resolved: string,
    open: OpenDocument,
    next: string,
    mode: number,
    options: WriteFileOptions,
    append: boolean,
  ): Promise<WriteResult> {
    const edits = textEdits(open.document.text(), next);
    if (edits.length === 0 && !append) {
      const result = await this.inner.writeFile(path, next, options);
      this.registry.recordStored(resolved, open, next, result.mutationToken);
      return { ...result, mutationToken: this.token(path) };
    }
    let stat = this.inner.stat(path);
    if (mode !== stat.mode) {
      const knownBase = stat.mutationToken === open.token;
      stat = this.inner.setMetadata(path, {
        mode,
        ifMutationToken: this.inner.getMutationToken(path),
      });
      if (knownBase) this.registry.recordMetadata(resolved, open, stat.mutationToken);
    }
    if (edits.length > 0) {
      open.document.applyExternal(edits);
      this.registry.markDirty(resolved);
    }
    return {
      path: resolved,
      revision: stat.revision,
      mutationToken: this.token(path),
      sizeBytes: utf8ByteLength(open.document.text()),
      created: false,
    };
  }
}
