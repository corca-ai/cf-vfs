import { VfsError } from "../core/errors.js";
import type { ByteRange, OpaqueStore, VirtualFileSystem } from "../vfs/types.js";
import type { ContentBody, ShellContentReader } from "./content.js";
import type { ShellBudget } from "./types.js";

/** The slice of the filesystem this reader needs: metadata plus a lease. */
type LeasedFileSystem = Pick<VirtualFileSystem, "stat" | "readFile" | "resolveOpaqueRead">;

export interface R2ContentReaderOptions {
  /** How long the object is retained against collection while being read. */
  readonly leaseMs?: number;
  /** Charged as the body streams, so an opaque read is metered like any other. */
  readonly budget?: ShellBudget;
}

/**
 * Streams an opaque body out of R2 for a shell command.
 *
 * The order matters and is the whole design. Metadata and the retention lease
 * are taken in one short SQL transaction; the R2 GET happens after it has
 * committed, never inside one, because a bucket round trip inside a
 * transaction would hold the Durable Object's storage lock for the length of a
 * network call. SQLite stays the only authority on what exists: the key comes
 * from the row, never from listing the bucket.
 *
 * Nothing is materialized. The bucket's stream is handed to the caller with
 * the byte count charged as it passes, so a body larger than the inline limit
 * — which is the only kind worth storing opaquely — costs bounded memory.
 */
export class R2ContentReader implements ShellContentReader {
  readonly #fileSystem: LeasedFileSystem;
  readonly #store: OpaqueStore;
  readonly #options: R2ContentReaderOptions;

  constructor(
    fileSystem: LeasedFileSystem,
    store: OpaqueStore,
    options: R2ContentReaderOptions = {},
  ) {
    this.#fileSystem = fileSystem;
    this.#store = store;
    this.#options = options;
  }

  async open(path: string, range?: ByteRange): Promise<ContentBody> {
    const stat = this.#fileSystem.stat(path);
    if (stat.kind !== "file" || stat.contentClass !== "opaque") {
      // An inline file is not this reader's business; answering it here would
      // mean two paths to the same bytes with two sets of behavior.
      const inline = this.#fileSystem.readFile(path);
      return { stat: inline.stat, stream: inline.stream, release: () => undefined };
    }

    const lease =
      this.#options.leaseMs === undefined
        ? this.#fileSystem.resolveOpaqueRead(path)
        : this.#fileSystem.resolveOpaqueRead(path, this.#options.leaseMs);

    const body = await this.#store.getStream(lease.object.key, range);
    if (body === null) {
      // The namespace says it exists and the bucket says it does not. That is
      // not "empty file" — it is a broken invariant, and reporting it as an
      // error is the only answer that cannot be mistaken for data.
      throw new VfsError("EIO", "opaque object is missing from storage", path);
    }
    if (lease.object.sizeBytes !== stat.sizeBytes && range === undefined) {
      // R2 objects are immutable, so a size that disagrees with the namespace
      // means the key was reused behind us. Refusing beats streaming bytes the
      // caller did not ask for.
      throw new VfsError("EIO", "opaque object changed unexpectedly", path);
    }

    const budget = this.#options.budget;
    const metered =
      budget === undefined
        ? body
        : body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                budget.io(chunk.byteLength);
                controller.enqueue(chunk);
              },
            }),
          );
    return { stat: lease.stat, stream: metered, release: () => undefined };
  }
}
