import { VfsError } from "../core/errors.js";
import { isDescendant, normalizePath } from "../core/path.js";
import { utf8ByteLength } from "../core/unicode.js";
import type { VfsEvent } from "../vfs/events.js";
import type { CollaborativeDocument, OpenDocument } from "./types.js";

interface Entry {
  document: CollaborativeDocument;
  token: string;
  dirty: boolean;
  version: number;
  publishedText: string;
  needsRefresh: boolean;
}

/**
 * The documents a workspace currently has open, keyed by path.
 *
 * Kept beside the filesystem rather than inside it: which files an application
 * is editing is not a filesystem fact, and nothing here is durable. What it
 * does own is the bookkeeping that is easy to get wrong — recognizing a
 * publication as one's own, and following a path when the namespace moves it.
 */
export class DocumentRegistry {
  #version = 0;
  readonly #open = new Map<string, Entry>();
  readonly #snapshots = new WeakMap<OpenDocument, Entry>();

  /**
   * Registers a document already holding the text at `token`.
   *
   * The token is the guard the first publication will use, so it must be the
   * one the text was read at. Reading the file and taking the token in the
   * other order would leave a window where a change is silently overwritten.
   */
  open(path: string, document: CollaborativeDocument, token: string): void {
    this.#open.set(normalizePath(path), {
      document,
      token,
      dirty: false,
      version: ++this.#version,
      publishedText: document.text(),
      needsRefresh: false,
    });
  }

  close(path: string): void {
    this.#open.delete(normalizePath(path));
  }

  get(path: string): OpenDocument | undefined {
    const normalized = normalizePath(path);
    const entry = this.#open.get(normalized);
    if (entry === undefined) return undefined;
    const snapshot: OpenDocument = {
      path: normalized,
      document: entry.document,
      token: entry.token,
      dirty: entry.dirty,
      version: entry.version,
      publishedText: entry.publishedText,
      needsRefresh: entry.needsRefresh,
    };
    this.#snapshots.set(snapshot, entry);
    return snapshot;
  }

  /** Whether a snapshot still names the same registration at the same token. */
  isUnchanged(path: string, snapshot: OpenDocument): boolean {
    const entry = this.#open.get(normalizePath(path));
    return entry === this.#snapshots.get(snapshot) && entry?.token === snapshot.token;
  }

  paths(): string[] {
    return [...this.#open.keys()];
  }

  /** Records that a document holds text the namespace has not been given. */
  markDirty(path: string): void {
    const entry = this.#open.get(normalizePath(path));
    if (entry !== undefined) {
      entry.dirty = true;
      entry.version = ++this.#version;
    }
  }

  /** Records a publication: the token it produced, and that nothing is pending. */
  markPublished(path: string, token: string): void {
    const entry = this.#open.get(normalizePath(path));
    if (entry === undefined) return;
    entry.token = token;
    entry.dirty = false;
    entry.publishedText = entry.document.text();
    entry.needsRefresh = false;
  }

  recordStored(path: string, snapshot: OpenDocument, text: string, token: string): void {
    if (!this.isUnchanged(path, snapshot)) return;
    const entry = this.#open.get(normalizePath(path));
    if (entry === undefined) return;
    entry.token = token;
    entry.publishedText = text;
    entry.needsRefresh = false;
    entry.dirty = entry.document.text() !== text;
  }

  recordMetadata(path: string, snapshot: OpenDocument, token: string): void {
    if (!this.isUnchanged(path, snapshot)) return;
    const entry = this.#open.get(normalizePath(path));
    if (entry !== undefined) entry.token = token;
  }

  mutationToken(path: string, storageToken: string): string {
    const entry = this.#open.get(normalizePath(path));
    return entry === undefined ? storageToken : `document:${entry.version}:${storageToken}`;
  }

  pendingGrowth(except: string): number {
    let bytes = 0;
    for (const [path, entry] of this.#open) {
      if (path !== except && entry.dirty)
        bytes += Math.max(
          0,
          utf8ByteLength(entry.document.text()) - utf8ByteLength(entry.publishedText),
        );
    }
    return bytes;
  }

  /**
   * Follows the namespace when a committed change moves or removes what is open.
   *
   * A move arrives as a range and a prefix rename, so every open path under it
   * is recomputed rather than looked up — which is exactly why the notification
   * carries a range instead of the paths in it. A removal closes what it took.
   *
   * A content change is deliberately not acted on here: whether a document
   * should be reconciled with it depends on whether this registry caused it,
   * which the caller decides by comparing the token it holds. See
   * `reconcileDocument`.
   */
  observe(event: VfsEvent): void {
    if (event.type !== "vfs.mutation") return;
    if (event.op === "move") {
      const subtree = event.subtree;
      if (subtree?.to === undefined) return;
      this.#relocate(subtree.root, subtree.to);
      return;
    }
    if (event.op !== "remove") return;
    const root = event.subtree?.root ?? event.path;
    for (const path of [...this.#open.keys()]) {
      if (path === root || isDescendant(root, path)) this.#open.delete(path);
    }
  }

  #relocate(root: string, to: string): void {
    const moved = [...this.#open].filter(([path]) => path === root || isDescendant(root, path));
    for (const path of [...this.#open.keys()]) {
      if (path === to || isDescendant(to, path)) this.#open.delete(path);
    }
    for (const [path] of moved) this.#open.delete(path);
    for (const [path, entry] of moved) {
      entry.version = ++this.#version;
      entry.needsRefresh = true;
      this.#open.set(`${to}${path.slice(root.length)}`, entry);
    }
  }
}

export function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VfsError("EINVAL", "a collaborative document must be valid UTF-8", path);
  }
}
