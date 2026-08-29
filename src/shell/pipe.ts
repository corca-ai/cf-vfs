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

class BytePipeState {
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #bytesWritten = 0;
  #cancelled: unknown;
  #pullWaiters: Array<() => void> = [];
  readonly options: BytePipeOptions;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(options: BytePipeOptions) {
    this.options = options;
    this.readable = this.#createReadable();
    this.writable = this.#createWritable();
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

  #createReadable(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => this.#wakeWriters(),
        cancel: (reason) => this.#consumerCancelled(reason),
      },
      {
        highWaterMark: Math.min(this.options.maximumBytes, 64 * 1024),
        size: (chunk) => chunk.byteLength,
      },
    );
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

  #createWritable(): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        try {
          this.#accept(chunk);
          await this.#waitForCapacity();
        } catch (error) {
          this.#fail(error);
          throw error;
        }
      },
      close: () => {
        this.#removeAbortListener();
        if (this.#cancelled === undefined) this.#controller?.close();
        this.#wakeWriters();
      },
      abort: (reason) => {
        this.#removeAbortListener();
        if (this.#cancelled === undefined) this.#controller?.error(reason);
        this.#wakeWriters();
      },
    });
  }
}

export function createBytePipe(options: BytePipeOptions): BytePipe {
  const state = new BytePipeState(options);
  if (options.signal.aborted) state.abortFromSignal();
  else options.signal.addEventListener("abort", state.abortFromSignal, { once: true });
  return { readable: state.readable, sink: sinkFromWritable(state.writable) };
}
