import { VfsError } from "../core/errors.js";
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

/**
 * The state behind one pipe. Writes go straight to the readable side rather
 * than through a writable stream, which on Workers saved a crossing into the
 * runtime per write; the queue, its capacity and backpressure are the
 * stream's own, as before.
 */
class BytePipeState {
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #bytesWritten = 0;
  #cancelled: unknown;
  #pullWaiters: Array<() => void> = [];
  readonly options: BytePipeOptions;
  readonly readable: ReadableStream<Uint8Array>;

  constructor(options: BytePipeOptions) {
    this.options = options;
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => this.#wakeWriters(),
        cancel: (reason) => this.#consumerCancelled(reason),
      },
      {
        highWaterMark: Math.min(options.maximumBytes, 64 * 1024),
        size: (chunk) => chunk.byteLength,
      },
    );
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
    if (this.#cancelled === undefined && (this.#controller?.desiredSize ?? 0) <= 0) return;
    const waiters = this.#pullWaiters;
    this.#pullWaiters = [];
    for (const resolve of waiters) resolve();
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
    try {
      this.#controller?.error(this.#cancelled);
    } catch {
      // The consumer may already have closed the stream.
    }
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
    this.#controller?.enqueue(chunk);
  }

  async #waitForCapacity(): Promise<void> {
    if ((this.#controller?.desiredSize ?? 1) > 0) return;
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
  }

  #fail(error: unknown): void {
    if (this.#cancelled === undefined) {
      this.#cancelled = error;
      try {
        this.#controller?.error(error);
      } catch {
        // The reader may have been cancelled concurrently.
      }
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
    if (this.#cancelled === undefined) this.#controller?.close();
    this.#wakeWriters();
  }

  abort(reason: unknown): void {
    this.#removeAbortListener();
    if (this.#cancelled === undefined) this.#controller?.error(reason);
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
