import { VfsError } from "../core/errors.js";
import type { ByteRange, OpaqueStore, VirtualFileSystem } from "../vfs/types.js";
import type { ContentBody, ShellContentReader } from "./content.js";

/**
 * Settles when the promise does, or when the execution is cancelled.
 *
 * A bucket GET is not interruptible, so the losing request is left to finish
 * and its body cancelled; what matters is that the command stops waiting.
 */
async function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  path: string,
): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) throw new VfsError("ECANCELED", "execution was cancelled", path);
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new VfsError("ECANCELED", "execution was cancelled", path));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void pending.then(
      (value) => {
        if (signal.aborted && value instanceof ReadableStream) void value.cancel().catch(() => {});
      },
      () => undefined,
    );
  }
}

/**
 * Turns a transfer failure into a diagnostic the shell can report.
 *
 * A 500, a throttle, or a dropped connection is ordinary bucket behavior, not
 * a broken invariant. Without this it escapes `executeText` as a rejection
 * rather than a status and a message on standard error.
 */
function reportingErrors(
  body: ReadableStream<Uint8Array>,
  path: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(
          error instanceof VfsError
            ? error
            : new VfsError("EIO", `opaque body could not be read: ${describe(error)}`, path),
        );
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The slice of the filesystem this reader needs: metadata plus a lease. */
type LeasedFileSystem = Pick<VirtualFileSystem, "stat" | "readFile" | "resolveOpaqueRead">;

export interface R2ContentReaderOptions {
  /**
   * How long the object is retained against collection while being read.
   *
   * Shorter than the execution deadline is a mistake this cannot detect: the
   * object becomes collectable while a command is still reading it, and the
   * read fails with the "missing from storage" error that is supposed to mean
   * a broken invariant.
   */
  readonly leaseMs?: number;
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

  async open(path: string, range?: ByteRange, signal?: AbortSignal): Promise<ContentBody> {
    const stat = this.#fileSystem.stat(path);
    if (stat.kind !== "file" || stat.contentClass !== "opaque") {
      // An inline file is not this reader's business; answering it here would
      // mean two paths to the same bytes with two sets of behavior.
      const inline = this.#fileSystem.readFile(path);
      return { stat: inline.stat, stream: inline.stream };
    }

    const lease =
      this.#options.leaseMs === undefined
        ? this.#fileSystem.resolveOpaqueRead(path)
        : this.#fileSystem.resolveOpaqueRead(path, this.#options.leaseMs);

    // The first network call a command makes, and the one place an execution
    // could sit past its deadline without noticing: a bucket that never
    // answers would otherwise leave the whole execution pending forever.
    let body: ReadableStream<Uint8Array> | null;
    try {
      body = await abortable(this.#store.getStream(lease.object.key, range), signal, path);
    } catch (error) {
      if (error instanceof VfsError) throw error;
      throw new VfsError("EIO", `opaque body could not be read: ${describe(error)}`, path);
    }
    if (body === null) {
      // The namespace says it exists and the bucket says it does not. That is
      // not "empty file" — it is a broken invariant, and reporting it as an
      // error is the only answer that cannot be mistaken for data.
      throw new VfsError("EIO", "opaque object is missing from storage", path);
    }
    // Bytes are already charged by whatever consumes them — `pipeToSink`,
    // `readTextLines`, `wc` — so nothing is metered here; doing it again would
    // charge an opaque read twice for the same bytes.
    return { stat: lease.stat, stream: reportingErrors(body, path) };
  }
}
