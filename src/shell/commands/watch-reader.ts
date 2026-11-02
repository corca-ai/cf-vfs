import { VfsError } from "../../core/errors.js";

/** The error an aborted execution raises, its own reason when that is one. */
export function cancellation(signal: AbortSignal): VfsError {
  return signal.reason instanceof VfsError
    ? signal.reason
    : new VfsError("ECANCELED", "execution was cancelled");
}

/** Reads of one reader that fail with the execution's cancellation when it aborts. */
export interface WatchedReader {
  /** Whether the signal has aborted, without asking the runtime. */
  readonly aborted: boolean;
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  /** Stops watching; call it once reading ends. */
  unwatch(): void;
}

/**
 * Watches `reader` for the execution's abort with one listener for the whole
 * read instead of one per chunk, each of which crosses into the runtime twice
 * on Workers. A read under way when the signal aborts fails at once with the
 * cancellation, and the reader is cancelled with it; after an abort, the next
 * read fails before it starts — as racing each read against the signal did.
 */
export function watchReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): WatchedReader {
  let aborted = signal.aborted;
  let fail: ((error: unknown) => void) | undefined;
  const abort = (): void => {
    aborted = true;
    const pending = fail;
    fail = undefined;
    if (pending === undefined) return;
    const error = cancellation(signal);
    void reader.cancel(error).catch(() => undefined);
    pending(error);
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    get aborted() {
      return aborted;
    },
    read: () => {
      if (aborted) return Promise.reject(cancellation(signal));
      return new Promise((resolve, reject) => {
        fail = reject;
        reader.read().then(
          (result) => {
            fail = undefined;
            resolve(result);
          },
          (error: unknown) => {
            fail = undefined;
            reject(error);
          },
        );
      });
    },
    unwatch: () => signal.removeEventListener("abort", abort),
  };
}
