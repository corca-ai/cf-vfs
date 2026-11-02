/** What a stream read directly hands its readers. */
export interface DirectSource {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason: unknown): Promise<void>;
  /** Settles when the source ends: fulfilled once read to the end, rejected when it fails. */
  closed(): Promise<undefined>;
  /** A reader let go: reads it left waiting are rejected, as a stream reader's are. */
  release(): void;
}

interface Direct {
  readonly source: DirectSource;
  native: boolean;
  /** A reader holds the stream, or a read without one is under way. */
  held: boolean;
}

const DIRECT = new WeakMap<ReadableStream<Uint8Array>, Direct>();

export const released = (): TypeError => new TypeError("the reader was released");

/** A promise settled from outside, its rejection marked handled. */
export function deferred(): {
  promise: Promise<undefined>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<undefined>((done, fail) => {
    resolve = () => done(undefined);
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Lets `getReader()` on `stream` read `source` without the native stream.
 *
 * On Workers every read from a native stream, every enqueue into one and
 * every reader lock crosses into the runtime, which costs more than a chunk
 * of text is worth. The stream stays a `ReadableStream`: a reader from
 * `getReader()` also takes the native lock, so `locked` and a second
 * `getReader()` behave as before. Whatever reads the native stream itself —
 * `pipeTo`, a `Response`, async iteration — makes the stream's `pull` call
 * the returned function first, and from then on every reader is native, so
 * native and direct readers never take turns over one source.
 */
export function readDirectly(stream: ReadableStream<Uint8Array>, source: DirectSource): () => void {
  const direct: Direct = { source, native: false, held: false };
  DIRECT.set(stream, direct);
  const nativeGetReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, "getReader", {
    configurable: true,
    writable: true,
    value: (options?: ReadableStreamGetReaderOptions) => {
      if (direct.native || options?.mode !== undefined) return nativeGetReader(options);
      if (direct.held) throw new TypeError("the stream is locked to a reader");
      return new DirectReader(direct, nativeGetReader());
    },
  });
  return () => {
    direct.native = true;
  };
}

/**
 * A reader of `stream` that takes no native lock, while nothing else holds
 * it: `undefined` when `stream` is not read directly or is held. It holds the
 * stream until released, as a reader would, without crossing into the
 * runtime to take or release a lock.
 */
export function readerWithoutLock(
  stream: ReadableStream<Uint8Array>,
): Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined {
  const direct = DIRECT.get(stream);
  if (direct === undefined || direct.native || direct.held) return undefined;
  direct.held = true;
  let held = true;
  return {
    read: () => (held ? direct.source.read() : Promise.reject(released())),
    cancel: (reason) => (held ? direct.source.cancel(reason) : Promise.reject(released())),
    releaseLock: () => {
      if (!held) return;
      held = false;
      direct.held = false;
      direct.source.release();
    },
  };
}

class DirectReader implements ReadableStreamDefaultReader<Uint8Array> {
  #direct: Direct | undefined;
  readonly #native: ReadableStreamDefaultReader<Uint8Array>;
  #closed: Promise<undefined> | undefined;
  #rejectClosed: ((error: unknown) => void) | undefined;

  constructor(direct: Direct, native: ReadableStreamDefaultReader<Uint8Array>) {
    direct.held = true;
    this.#direct = direct;
    this.#native = native;
  }

  /** The reader's own, as a stream reader's is: releasing the reader rejects it. */
  get closed(): Promise<undefined> {
    if (this.#closed === undefined) {
      const direct = this.#direct;
      if (direct === undefined) {
        this.#closed = Promise.reject(released());
        this.#closed.catch(() => undefined);
      } else {
        const own = deferred();
        this.#rejectClosed = own.reject;
        direct.source.closed().then(own.resolve, own.reject);
        this.#closed = own.promise;
      }
    }
    return this.#closed;
  }

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    return this.#direct === undefined ? Promise.reject(released()) : this.#direct.source.read();
  }

  cancel(reason?: unknown): Promise<void> {
    return this.#direct === undefined
      ? Promise.reject(released())
      : this.#direct.source.cancel(reason);
  }

  releaseLock(): void {
    const direct = this.#direct;
    if (direct === undefined) return;
    this.#direct = undefined;
    direct.held = false;
    this.#rejectClosed?.(released());
    direct.source.release();
    this.#native.releaseLock();
  }
}

// `instanceof ReadableStreamDefaultReader` holds, as it did for the readers
// these replace; every member is the class's own.
Object.setPrototypeOf(DirectReader.prototype, ReadableStreamDefaultReader.prototype);
