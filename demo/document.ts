import type { CollaborativeFileSystem } from "../src/collab/index.js";
import {
  applyTextEdits,
  type CollaborativeDocument,
  DocumentRegistry,
  type TextEdit,
  textEdits,
} from "../src/collab/index.js";
import { VfsError } from "../src/core/errors.js";
import type { VfsEvent } from "../src/vfs/events.js";
import { readAllBytes } from "../src/vfs/streams.js";

/** How long after the last change a document is written back. */
const PUBLISH_DELAY_MS = 400;
/** The room's per-file ceiling, refused here so a client hears why. */
const MAX_DOCUMENT_BYTES = 16 * 1024;

/**
 * A document that is a string.
 *
 * The demo deliberately does not ship a CRDT, and the reason is worth stating
 * because it is easy to assume one is always required. Every change to this
 * workspace — a keystroke arriving on a socket, a `sed -i` inside a shell —
 * runs on one Durable Object. Asynchronous operations can interleave: document
 * guards refuse stale writes and reconciliation merges disjoint edits from a
 * common base. Overlapping edits remain pending and report a save error.
 *
 * What would change that is a client applying its own edits before the server
 * has confirmed them. This one does not: it sends what it has and takes what
 * comes back, and a version stamp catches the case where those cross. A host
 * that wants optimistic local editing is the host that plugs Yjs in here,
 * which is exactly why `CollaborativeDocument` is an interface.
 */
export class DemoDocument implements CollaborativeDocument {
  #text: string;
  #version = 0;

  constructor(text: string) {
    this.#text = text;
  }

  text(): string {
    return this.#text;
  }

  /** Bumped on every applied change, whoever made it. */
  version(): number {
    return this.#version;
  }

  applyExternal(edits: readonly TextEdit[]): void {
    if (edits.length === 0) return;
    this.#text = applyTextEdits(this.#text, edits);
    this.#version += 1;
  }
}

export interface DocumentNotice {
  readonly path: string;
  readonly kind: "changed" | "gone" | "moved" | "error";
  readonly message?: string;
  readonly to?: string;
}

/**
 * The demo's open documents, and the bookkeeping around them.
 *
 * Constructed before `super()` in the Durable Object so it can be handed to
 * the filesystem as its event sink, which is what lets it follow a `mv` or an
 * `rm` performed from the terminal.
 */
export class DemoDocuments {
  readonly registry = new DocumentRegistry();
  readonly #documents = new Map<string, DemoDocument>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #fileSystem: CollaborativeFileSystem | undefined;
  #notify: ((notice: DocumentNotice) => void) | undefined;

  /** Wired after `super()`, when the object has a filesystem and sockets. */
  attach(fileSystem: CollaborativeFileSystem, notify: (notice: DocumentNotice) => void): void {
    this.#fileSystem = fileSystem;
    this.#notify = notify;
  }

  get(path: string): DemoDocument | undefined {
    return this.#documents.get(path);
  }

  /**
   * Reads a path into an open document, or returns the one already open.
   *
   * The token is taken from the same read, because it is the guard the first
   * publication uses: taking it separately would leave a window where a change
   * between the two is overwritten instead of refused.
   */
  async open(path: string): Promise<DemoDocument> {
    const existing = this.#documents.get(path);
    if (existing !== undefined) return existing;
    const fileSystem = this.#require();
    const read = fileSystem.readFile(path);
    const bytes = await readAllBytes(read.stream, MAX_DOCUMENT_BYTES);
    const document = new DemoDocument(decode(bytes, path));
    this.#documents.set(path, document);
    this.registry.open(path, document, read.stat.mutationToken);
    return document;
  }

  close(path: string): void {
    this.#documents.delete(path);
    this.registry.close(path);
    const timer = this.#timers.get(path);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(path);
  }

  openPaths(): string[] {
    return [...this.#documents.keys()];
  }

  /**
   * Drops every document and cancels the writes that were still pending.
   *
   * A scheduled publication outlives the thing it was going to write to, so
   * anything that tears a room down has to say so rather than leave a timer
   * pointing at a closed database.
   */
  dispose(): void {
    for (const path of [...this.#documents.keys()]) this.close(path);
  }

  /**
   * Applies a client's text, refusing it when the client was working from a
   * version something else has already replaced.
   *
   * The same shape as the filesystem's own mutation token one level down: a
   * stale writer is told so rather than allowed to overwrite, and resynchronizes.
   */
  applyClientText(path: string, base: number, text: string): "applied" | "stale" {
    const document = this.#documents.get(path);
    if (document === undefined) throw new VfsError("ENOENT", "document is not open", path);
    if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES) {
      throw new VfsError("EFBIG", "document is larger than this room allows", path);
    }
    if (base !== document.version()) return "stale";
    const before = document.text();
    if (before === text) return "applied";
    document.applyExternal(textEdits(before, text));
    this.registry.markDirty(path);
    this.schedulePublish(path);
    return "applied";
  }

  /**
   * Notices that a document changed underneath, and schedules its write-back.
   *
   * Called after a shell execution, because a write-through leaves the
   * document ahead of storage and nothing else would publish it.
   */
  noticeShellWrites(): void {
    for (const path of this.#documents.keys()) {
      const open = this.registry.get(path);
      if (open?.dirty !== true) continue;
      this.#notify?.({ path, kind: "changed" });
      this.schedulePublish(path);
    }
  }

  schedulePublish(path: string): void {
    const existing = this.#timers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    this.#timers.set(
      path,
      setTimeout(() => {
        this.#timers.delete(path);
        void this.#publish(path).catch((error: unknown) => {
          this.#notify?.({
            path,
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, PUBLISH_DELAY_MS),
    );
  }

  async #publish(path: string): Promise<void> {
    const fileSystem = this.#require();
    try {
      await fileSystem.publish(path);
    } catch (error) {
      if (!(error instanceof VfsError) || error.code !== "EREVISION") throw error;
      // Something replaced the file outside this document. Take what is there
      // as an external change and publish once more; a second conflict is left
      // alone rather than retried in a loop.
      await fileSystem.reconcile(path);
      await fileSystem.publish(path);
      this.#notify?.({ path, kind: "changed" });
    }
  }

  /** Follows the namespace, so a `mv` or `rm` in the terminal is not a stale tab. */
  observe(event: VfsEvent): void {
    if (event.type !== "vfs.mutation") return;
    const before = new Set(this.#documents.keys());
    this.registry.observe(event);
    if (event.op === "move" && event.subtree?.to !== undefined) {
      const { root, to } = event.subtree;
      for (const path of before) {
        if (path !== root && !path.startsWith(`${root}/`)) continue;
        const moved = `${to}${path.slice(root.length)}`;
        const document = this.#documents.get(path);
        if (document === undefined) continue;
        this.#documents.delete(path);
        this.#documents.set(moved, document);
        this.#notify?.({ path, kind: "moved", to: moved });
      }
      return;
    }
    if (event.op !== "remove") return;
    const root = event.subtree?.root ?? event.path;
    for (const path of before) {
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      this.close(path);
      this.#notify?.({ path, kind: "gone" });
    }
  }

  #require(): CollaborativeFileSystem {
    if (this.#fileSystem === undefined) throw new VfsError("EIO", "documents are not attached");
    return this.#fileSystem;
  }
}

function decode(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VfsError("EINVAL", "this file is not text", path);
  }
}
