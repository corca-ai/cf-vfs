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
  return error instanceof DownstreamClosedError
    || (typeof error === "object" && error !== null && "downstreamClosed" in error
      && error.downstreamClosed === true);
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

export function createBytePipe(options: BytePipeOptions): BytePipe {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bytesWritten = 0;
  let cancelled: unknown;
  let pullWaiters: Array<() => void> = [];

  const cancellationError = (): unknown => options.signal.reason
    ?? new VfsError("ECANCELED", "execution was cancelled");

  function wakeWriters(): void {
    if (cancelled === undefined && (controller?.desiredSize ?? 0) <= 0) return;
    const waiters = pullWaiters;
    pullWaiters = [];
    for (const resolve of waiters) resolve();
  }

  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull() {
      wakeWriters();
    },
    cancel(reason) {
      cancelled = options.onConsumerCancel === undefined
        ? new DownstreamClosedError(`${options.name} consumer closed early`)
        : reason ?? new VfsError("ECANCELED", `${options.name} consumer cancelled execution`);
      if (options.onConsumerCancel !== undefined) {
        const cancelExecution = options.onConsumerCancel;
        const cancellation = cancelled;
        void Promise.resolve().then(() => cancelExecution(cancellation));
      }
      wakeWriters();
    },
  }, {
    highWaterMark: Math.min(options.maximumBytes, 64 * 1024),
    size: (chunk) => chunk.byteLength,
  });

  const onAbort = (): void => {
    if (cancelled !== undefined) return;
    cancelled = cancellationError();
    try {
      controller?.error(cancelled);
    } catch {
      // The consumer may already have closed the stream.
    }
    wakeWriters();
  };
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });

  function removeAbortListener(): void {
    options.signal.removeEventListener("abort", onAbort);
  }

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        if (options.signal.aborted) {
          throw cancellationError();
        }
        if (cancelled !== undefined) {
          throw cancelled instanceof Error
            ? cancelled
            : new VfsError("EPIPE", `${options.name} consumer closed early`);
        }
        bytesWritten += chunk.byteLength;
        options.account?.(chunk.byteLength);
        if (bytesWritten > options.maximumBytes) {
          throw new VfsError(
            "E2BIG",
            `${options.name} exceeds the ${options.maximumBytes}-byte limit`,
          );
        }
        controller?.enqueue(chunk.slice());
        if ((controller?.desiredSize ?? 1) <= 0) {
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          if (options.idleTimeoutMs !== undefined && options.onIdle !== undefined) {
            idleTimer = setTimeout(options.onIdle, options.idleTimeoutMs);
          }
          try {
            await new Promise<void>((resolve) => pullWaiters.push(resolve));
          } finally {
            if (idleTimer !== undefined) clearTimeout(idleTimer);
          }
          if (options.signal.aborted) throw cancellationError();
          const reason: unknown = cancelled;
          if (reason !== undefined) {
            throw reason instanceof Error
              ? reason
              : new VfsError("EPIPE", `${options.name} consumer closed early`);
          }
        }
      } catch (error) {
        if (cancelled === undefined) {
          cancelled = error;
          try {
            controller?.error(error);
          } catch {
            // The reader may have been cancelled concurrently.
          }
        }
        wakeWriters();
        throw error;
      }
    },
    close() {
      removeAbortListener();
      if (cancelled === undefined) controller?.close();
      wakeWriters();
    },
    abort(reason) {
      removeAbortListener();
      if (cancelled === undefined) controller?.error(reason);
      wakeWriters();
    },
  });

  return { readable, sink: sinkFromWritable(writable) };
}
