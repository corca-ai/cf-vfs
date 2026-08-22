import { VfsError } from "../core/errors.js";
import { isDescendant, normalizePath } from "../core/path.js";
import type { VfsEvent } from "../vfs/events.js";
import { readAllBytes } from "../vfs/streams.js";
import type { VirtualFileSystem } from "../vfs/types.js";
import { textEdits } from "./edits.js";
import type { CollaborativeDocument, OpenDocument } from "./types.js";

interface Entry {
  document: CollaborativeDocument;
  token: string;
  dirty: boolean;
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
  readonly #open = new Map<string, Entry>();

  /**
   * Registers a document already holding the text at `token`.
   *
   * The token is the guard the first publication will use, so it must be the
   * one the text was read at. Reading the file and taking the token in the
   * other order would leave a window where a change is silently overwritten.
   */
  open(path: string, document: CollaborativeDocument, token: string): void {
    this.#open.set(normalizePath(path), { document, token, dirty: false });
  }

  close(path: string): void {
    this.#open.delete(normalizePath(path));
  }

  get(path: string): OpenDocument | undefined {
    const normalized = normalizePath(path);
    const entry = this.#open.get(normalized);
    return entry === undefined
      ? undefined
      : { path: normalized, document: entry.document, token: entry.token, dirty: entry.dirty };
  }

  paths(): string[] {
    return [...this.#open.keys()];
  }

  /** Records that a document holds text the namespace has not been given. */
  markDirty(path: string): void {
    const entry = this.#open.get(normalizePath(path));
    if (entry !== undefined) entry.dirty = true;
  }

  /** Records a publication: the token it produced, and that nothing is pending. */
  markPublished(path: string, token: string): void {
    const entry = this.#open.get(normalizePath(path));
    if (entry === undefined) return;
    entry.token = token;
    entry.dirty = false;
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
    for (const [path, entry] of [...this.#open]) {
      if (path !== root && !isDescendant(root, path)) continue;
      this.#open.delete(path);
      this.#open.set(`${to}${path.slice(root.length)}`, entry);
    }
  }
}

/**
 * The largest document this module will read back out of the namespace.
 *
 * A collaborative document is text someone is editing, and the inline ceiling
 * is already 8 MiB; this bounds the reconciliation read rather than inventing
 * a policy about file size.
 */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/**
 * Brings an open document up to date with what the namespace holds.
 *
 * For a change this registry did not make — another caller, a restored file.
 * Compare the notification's token against the one `get()` reports first: they
 * match when the change was this registry's own publication, and reconciling
 * against that would be work with no result.
 *
 * Returns whether the document changed.
 */
export async function reconcileDocument(
  fileSystem: Pick<VirtualFileSystem, "readFile">,
  registry: DocumentRegistry,
  path: string,
): Promise<boolean> {
  const open = registry.get(path);
  if (open === undefined) return false;
  const read = fileSystem.readFile(path);
  const bytes = await readAllBytes(read.stream, MAX_DOCUMENT_BYTES);
  const stored = decodeText(bytes, path);
  const edits = textEdits(open.document.text(), stored);
  if (edits.length === 0) {
    registry.markPublished(path, read.stat.mutationToken);
    return false;
  }
  open.document.applyExternal(edits);
  registry.markPublished(path, read.stat.mutationToken);
  return true;
}

/**
 * Publishes an open document, guarded by the token it was last read at.
 *
 * `skipIfUnchanged` is what keeps a timer-driven flush from churning: an
 * unchanged publication would still bump the revision and invalidate every
 * other holder's guard on that path.
 *
 * Fails with `EREVISION` when the namespace moved underneath, which is the
 * caller's signal to reconcile and try again rather than to overwrite.
 */
export async function publishDocument(
  fileSystem: Pick<VirtualFileSystem, "writeFile">,
  registry: DocumentRegistry,
  path: string,
): Promise<boolean> {
  const open = registry.get(path);
  if (open === undefined || !open.dirty) return false;
  const result = await fileSystem.writeFile(path, open.document.text(), {
    ifMutationToken: open.token,
    skipIfUnchanged: true,
  });
  registry.markPublished(path, result.mutationToken);
  return true;
}

export function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VfsError("EINVAL", "a collaborative document must be valid UTF-8", path);
  }
}
