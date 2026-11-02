import { VfsError } from "../core/errors.js";
import { type DirectSource, deferred, readDirectly, released } from "./direct-read.js";
import type { ShellSink } from "./types.js";

interface BytePipeOptions {
  maximumBytes: number;
  signal: AbortSignal;
  name: string;
  account?: (bytes: number) => void;
  idleTimeoutMs?: number;
  onIdle?: () => void;
  onConsumerCancel?: (reason: unknown) => void;
}

export class DownstreamClosedError extends VfsError {
  readonly downstreamClosed = true;

  constructor(message: string) {
    super("EPIPE", message);
    this.name = "DownstreamClosedError";
  }
}

export function isDownstreamClosedError(error: unknown): error is DownstreamClosedError {
  return (
    error instanceof DownstreamClosedError ||
    (typeof error === "object" &&
      error !== null &&
      "downstreamClosed" in error &&
      error.downstreamClosed === true)
  );
}

export interface BytePipe {
  readable: ReadableStream<Uint8Array>;
  sink: ShellSink;
}

interface SharedSinkState {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  references: number;
  terminal: boolean;
}

class SharedSink implements ShellSink {
  private readonly state: SharedSinkState;
  private released = false;

  constructor(state: SharedSinkState) {
    this.state = state;
  }

  clone(): ShellSink {
    if (this.released || this.state.terminal) throw new VfsError("EPIPE", "sink is closed");
    this.state.references += 1;
    return new SharedSink(this.state);
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.released || this.state.terminal) throw new VfsError("EPIPE", "sink is closed");
    await this.state.writer.write(chunk.slice());
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.state.terminal) return;
    this.state.references -= 1;
    if (this.state.references === 0) {
      this.state.terminal = true;
      await this.state.writer.close();
    }
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.state.terminal) return;
    this.state.references = 0;
    this.state.terminal = true;
    await this.state.writer.abort(reason);
  }
}

export function sinkFromWritable(writable: WritableStream<Uint8Array>): ShellSink {
  return new SharedSink({ writer: writable.getWriter(), references: 1, terminal: false });
}

const DONE: ReadableStreamReadDoneResult<Uint8Array> = Object.freeze({
  done: true,
  value: undefined,
});
const EMPTY = new Uint8Array(0);

interface PendingRead {
  resolve: (result: ReadableStreamReadResult<Uint8Array>) => void;
  reject: (error: unknown) => void;
}

/**
 * The state behind one pipe: a queue of chunks kept in JavaScript.
 *
 * Readers from `getReader()`, and a pipeline stage's input, read the queue
 * directly (see {@link readDirectly}), so a chunk makes no runtime crossing on
 * Workers. Whatever reads the native stream itself — `pipeTo`, a `Response`,
 * async iteration — pulls from the same queue, one chunk per read, and from
 * then on every reader is native. Capacity, backpressure, closing,
 * cancelling and errors follow a default stream with a high-water mark of
 * `min(maximumBytes, 64 KiB)` bytes.
 *
 * `#cancelled` is why writes fail: the consumer cancelled, the execution was
 * aborted, or a write failed. `#finished` is what readers see once the queue
 * is drained: the end, or `#error`.
 */
class BytePipeState implements DirectSource {
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #goNative: () => void;
  #queue: Uint8Array[] = [];
  #head = 0;
  #queuedBytes = 0;
  #reads: PendingRead[] = [];
  #closeRequested = false;
  #finished: "closed" | "errored" | undefined;
  #error: unknown;
  #closed: ReturnType<typeof deferred> | undefined;
  #bytesWritten = 0;
  #cancelled: unknown;
  #pullWaiters: Array<() => void> = [];
  readonly #capacity: number;
  readonly options: BytePipeOptions;
  readonly readable: ReadableStream<Uint8Array>;

  constructor(options: BytePipeOptions) {
    this.options = options;
    this.#capacity = Math.min(options.maximumBytes, 64 * 1024);
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: (controller) => this.#pull(controller),
        cancel: (reason) => this.cancel(reason),
      },
      // Zero pulls only for a read, so the native queue holds nothing.
      { highWaterMark: 0 },
    );
    this.#goNative = readDirectly(this.readable, this);
  }

  async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    this.#goNative();
    try {
      const result = await this.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    } catch (error) {
      try {
        controller.error(error);
      } catch {
        // The stream already failed or was cancelled.
      }
    }
  }

  #cancellationError(): unknown {
    return this.options.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
  }

  #closedError(): Error {
    return this.#cancelled instanceof Error
      ? this.#cancelled
      : new VfsError("EPIPE", `${this.options.name} consumer closed early`);
  }

  #wakeWriters(): void {
    if (
      this.#cancelled === undefined &&
      this.#finished !== "errored" &&
      this.#queuedBytes >= this.#capacity
    )
      return;
    const waiters = this.#pullWaiters;
    this.#pullWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #settleReads(settle: (read: PendingRead) => void): void {
    const reads = this.#reads;
    this.#reads = [];
    for (const read of reads) settle(read);
  }

  #enqueue(chunk: Uint8Array): void {
    // An empty chunk carries nothing; the native stream dropped it on Workers.
    if (chunk.byteLength === 0 || this.#finished !== undefined || this.#closeRequested) return;
    const read = this.#reads.shift();
    if (read !== undefined) {
      read.resolve({ done: false, value: chunk });
      return;
    }
    this.#queue.push(chunk);
    this.#queuedBytes += chunk.byteLength;
  }

  #dequeue(): Uint8Array {
    const chunk = this.#queue[this.#head] ?? EMPTY;
    this.#queue[this.#head] = EMPTY;
    this.#head += 1;
    this.#queuedBytes -= chunk.byteLength;
    if (this.#head === this.#queue.length) {
      this.#queue = [];
      this.#head = 0;
    } else if (this.#head >= 1024 && this.#head * 2 >= this.#queue.length) {
      this.#queue = this.#queue.slice(this.#head);
      this.#head = 0;
    }
    return chunk;
  }

  #discardQueue(): void {
    this.#queue = [];
    this.#head = 0;
    this.#queuedBytes = 0;
  }

  #finishClosed(): void {
    this.#finished = "closed";
    this.#closed?.resolve();
    this.#settleReads((read) => read.resolve(DONE));
  }

  /** As a stream controller's `error()`: discards the queue and fails every read. */
  #errorStream(error: unknown): void {
    if (this.#finished !== undefined) return;
    this.#finished = "errored";
    this.#error = error;
    // The native stream fails at once, as it did, so a consumer of it sees
    // the error before it next reads.
    try {
      this.#controller?.error(error);
    } catch {
      // The consumer may already have cancelled the stream.
    }
    this.#discardQueue();
    this.#closed?.reject(error);
    this.#settleReads((read) => read.reject(error));
  }

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.#head < this.#queue.length) {
      const value = this.#dequeue();
      if (this.#closeRequested && this.#head === this.#queue.length) this.#finishClosed();
      else this.#wakeWriters();
      return Promise.resolve({ done: false, value });
    }
    if (this.#finished === "errored") return Promise.reject(this.#error);
    if (this.#finished === "closed") return Promise.resolve(DONE);
    return new Promise((resolve, reject) => this.#reads.push({ resolve, reject }));
  }

  release(): void {
    this.#settleReads((read) => read.reject(released()));
  }

  closed(): Promise<undefined> {
    if (this.#closed === undefined) {
      this.#closed = deferred();
      if (this.#finished === "closed") this.#closed.resolve();
      else if (this.#finished === "errored") this.#closed.reject(this.#error);
    }
    return this.#closed.promise;
  }

  /** The consumer gives up: what is queued is dropped and the stream ends. */
  cancel(reason: unknown): Promise<void> {
    if (this.#finished === "errored") return Promise.reject(this.#error);
    if (this.#finished === "closed") return Promise.resolve();
    this.#discardQueue();
    this.#finishClosed();
    this.#consumerCancelled(reason);
    return Promise.resolve();
  }

  #consumerCancelled(reason: unknown): void {
    this.#cancelled =
      this.options.onConsumerCancel === undefined
        ? new DownstreamClosedError(`${this.options.name} consumer closed early`)
        : (reason ??
          new VfsError("ECANCELED", `${this.options.name} consumer cancelled execution`));
    if (this.options.onConsumerCancel !== undefined) {
      const cancelExecution = this.options.onConsumerCancel;
      const cancellation = this.#cancelled;
      void Promise.resolve().then(() => cancelExecution(cancellation));
    }
    this.#wakeWriters();
  }

  abortFromSignal = (): void => {
    if (this.#cancelled !== undefined) return;
    this.#cancelled = this.#cancellationError();
    this.#errorStream(this.#cancelled);
    this.#wakeWriters();
  };

  #removeAbortListener(): void {
    this.options.signal.removeEventListener("abort", this.abortFromSignal);
  }

  #accept(chunk: Uint8Array): void {
    if (this.options.signal.aborted) throw this.#cancellationError();
    if (this.#cancelled !== undefined) throw this.#closedError();
    this.#bytesWritten += chunk.byteLength;
    this.options.account?.(chunk.byteLength);
    if (this.#bytesWritten > this.options.maximumBytes) {
      throw new VfsError(
        "E2BIG",
        `${this.options.name} exceeds the ${this.options.maximumBytes}-byte limit`,
      );
    }
    this.#enqueue(chunk);
  }

  async #waitForCapacity(): Promise<void> {
    if (this.#queuedBytes < this.#capacity) return;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.options.idleTimeoutMs !== undefined && this.options.onIdle !== undefined) {
      idleTimer = setTimeout(this.options.onIdle, this.options.idleTimeoutMs);
    }
    try {
      await new Promise<void>((resolve) => this.#pullWaiters.push(resolve));
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    }
    if (this.options.signal.aborted) throw this.#cancellationError();
    if (this.#cancelled !== undefined) throw this.#closedError();
    // Another descriptor of the same pipe aborted it: the bytes went nowhere.
    if (this.#finished === "errored") throw this.#error;
  }

  #fail(error: unknown): void {
    if (this.#cancelled === undefined) {
      this.#cancelled = error;
      this.#errorStream(error);
    }
    this.#wakeWriters();
  }

  /** `chunk` is the pipe's own: the sink copied it when the write was made. */
  async write(chunk: Uint8Array): Promise<void> {
    try {
      this.#accept(chunk);
      await this.#waitForCapacity();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  close(): void {
    this.#removeAbortListener();
    if (this.#cancelled === undefined && this.#finished === undefined && !this.#closeRequested) {
      this.#closeRequested = true;
      if (this.#head === this.#queue.length) this.#finishClosed();
    }
    this.#wakeWriters();
  }

  abort(reason: unknown): void {
    this.#removeAbortListener();
    if (this.#cancelled === undefined) this.#errorStream(reason);
    this.#wakeWriters();
  }
}

interface PipeSinkState {
  readonly pipe: BytePipeState;
  references: number;
  terminal: boolean;
  /** Writes run one at a time in call order, as a stream writer queues them. */
  tail: Promise<void>;
  writing: number;
  failure: unknown;
}

/** The writing end of a pipe, shared by every descriptor duplicated from it. */
class PipeSink implements ShellSink {
  private readonly state: PipeSinkState;
  private released = false;

  constructor(state: PipeSinkState) {
    this.state = state;
  }

  clone(): ShellSink {
    if (this.released || this.state.terminal) throw new VfsError("EPIPE", "sink is closed");
    this.state.references += 1;
    return new PipeSink(this.state);
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.released || this.state.terminal) {
      return Promise.reject(new VfsError("EPIPE", "sink is closed"));
    }
    const { state } = this;
    // The bytes are taken when the call is made, as a stream writer does.
    const idle = state.writing === 0 && state.failure === undefined;
    const bytes = chunk.slice();
    state.writing += 1;
    const written = idle
      ? state.pipe.write(bytes)
      : state.tail.then(() => {
          if (state.failure !== undefined) throw state.failure;
          return state.pipe.write(bytes);
        });
    const settled = written.then(
      () => {
        state.writing -= 1;
      },
      (error: unknown) => {
        state.writing -= 1;
        state.failure ??= error;
      },
    );
    state.tail = settled;
    return written;
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.state.terminal) return;
    this.state.references -= 1;
    if (this.state.references === 0) {
      this.state.terminal = true;
      await this.state.tail;
      if (this.state.failure !== undefined) throw this.state.failure;
      this.state.pipe.close();
    }
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.state.terminal) return;
    this.state.references = 0;
    this.state.terminal = true;
    this.state.failure ??= reason ?? new VfsError("EPIPE", "sink was aborted");
    this.state.pipe.abort(reason);
  }
}

export function createBytePipe(options: BytePipeOptions): BytePipe {
  const state = new BytePipeState(options);
  if (options.signal.aborted) state.abortFromSignal();
  else options.signal.addEventListener("abort", state.abortFromSignal, { once: true });
  return {
    readable: state.readable,
    sink: new PipeSink({
      pipe: state,
      references: 1,
      terminal: false,
      tail: Promise.resolve(),
      writing: 0,
      failure: undefined,
    }),
  };
}
