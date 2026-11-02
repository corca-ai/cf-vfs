import { VfsError } from "../core/errors.js";
import { chargeConsumed } from "./content.js";
import {
  type DirectSource,
  deferred,
  readDirectly,
  readerWithoutLock,
  released,
} from "./direct-read.js";
import type { ShellBudget } from "./types.js";

export interface InputRecord {
  value: string;
  terminated: boolean;
  empty: boolean;
}

interface PendingBytes {
  bytes: Uint8Array;
  release(): void;
}

class ShellInputCursor {
  private readonly source: ReadableStream<Uint8Array>;
  private pending: PendingBytes | undefined;
  private done = false;
  private reading = false;

  constructor(source: ReadableStream<Uint8Array>) {
    this.source = source;
  }

  private takePending(): Uint8Array | undefined {
    const pending = this.pending;
    if (pending === undefined) return undefined;
    this.pending = undefined;
    pending.release();
    return pending.bytes;
  }

  private retain(bytes: Uint8Array, budget: ShellBudget): void {
    if (bytes.byteLength === 0) return;
    const release = budget.buffered(bytes.byteLength);
    try {
      this.pending = { bytes: bytes.slice(), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async readChunk(signal?: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal?.aborted === true) {
      throw signal.reason instanceof VfsError
        ? signal.reason
        : new VfsError("ECANCELED", "execution was cancelled");
    }
    const pending = this.takePending();
    if (pending !== undefined) return { done: false, value: pending };
    if (this.done) return { done: true, value: undefined };
    if (this.reading) throw new VfsError("EIO", "shell input is already being consumed");
    this.reading = true;
    // A pipe is read without a native lock: taking and releasing one per
    // chunk would cross into the runtime twice on Workers.
    const reader = readerWithoutLock(this.source) ?? this.source.getReader();
    const cancelled = (): VfsError =>
      signal?.reason instanceof VfsError
        ? signal.reason
        : new VfsError("ECANCELED", "execution was cancelled");
    const abort = (): void => {
      const error = cancelled();
      void reader.cancel(error).catch(() => undefined);
    };
    try {
      const result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abortRead = (): void => {
          const error = cancelled();
          abort();
          reject(error);
        };
        signal?.addEventListener("abort", abortRead, { once: true });
        void reader
          .read()
          .then(resolve, reject)
          .finally(() => {
            signal?.removeEventListener("abort", abortRead);
          });
      });
      if (result.done) this.done = true;
      return result;
    } finally {
      reader.releaseLock();
      this.reading = false;
    }
  }

  async readRecord(budget: ShellBudget, signal: AbortSignal): Promise<InputRecord> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let value = "";
    let contentBytes = 0;
    let release: () => void = () => undefined;
    const decode = (bytes: Uint8Array, stream: boolean): void => {
      if (bytes.byteLength === 0) return;
      contentBytes += bytes.byteLength;
      release();
      release = budget.buffered(contentBytes);
      try {
        value += decoder.decode(bytes, { stream });
      } catch {
        throw new VfsError("EIO", "read: input is not valid UTF-8");
      }
    };
    const finish = (): string => {
      try {
        value += decoder.decode();
      } catch {
        throw new VfsError("EIO", "read: input is not valid UTF-8");
      }
      if (value.includes("\0")) throw new VfsError("EINVAL", "read: input contains a NUL byte");
      return value;
    };
    try {
      while (true) {
        const result = await this.readChunk(signal);
        if (result.done) {
          if (contentBytes === 0) return { value: "", terminated: false, empty: true };
          return {
            value: finish(),
            terminated: false,
            empty: false,
          };
        }
        const newline = result.value.indexOf(0x0a);
        const consumedBytes = newline < 0 ? result.value.byteLength : newline + 1;
        chargeConsumed(budget, this.source, consumedBytes);
        if (contentBytes + consumedBytes > budget.limits.maxLineBytes) {
          throw new VfsError("E2BIG", "read: line byte limit exceeded");
        }
        if (newline < 0) {
          decode(result.value, true);
          continue;
        }
        decode(result.value.subarray(0, newline), true);
        this.retain(result.value.subarray(newline + 1), budget);
        return {
          value: finish(),
          terminated: true,
          empty: false,
        };
      }
    } catch (error) {
      await this.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    this.done = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.release();
    await this.source.cancel(reason);
  }
}

interface PendingRead {
  resolve: (result: ReadableStreamReadResult<Uint8Array>) => void;
  reject: (error: unknown) => void;
}

/**
 * A stage input as its readers see it, as the stream over the cursor did:
 * reads are answered in order with one read of the cursor at a time, a read
 * finished after its reader let go is kept for the next one, and once the
 * cursor fails every later read and cancel fails the same way.
 */
class InputReads implements DirectSource {
  readonly #cursor: ShellInputCursor;
  #waiting: PendingRead[] = [];
  #reading = false;
  #kept: ReadableStreamReadResult<Uint8Array> | undefined;
  #failed = false;
  #error: unknown;
  readonly #closed = deferred();

  constructor(cursor: ShellInputCursor) {
    this.#cursor = cursor;
  }

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.#failed) return Promise.reject(this.#error);
    const kept = this.#kept;
    if (kept !== undefined) {
      this.#kept = undefined;
      return Promise.resolve(kept);
    }
    return new Promise((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
      this.#next();
    });
  }

  #next(): void {
    if (this.#reading || this.#waiting.length === 0) return;
    this.#reading = true;
    this.#cursor.readChunk().then(
      (result) => {
        this.#reading = false;
        if (result.done) this.#closed.resolve();
        const read = this.#waiting.shift();
        if (read === undefined) this.#kept = result;
        else read.resolve(result);
        this.#next();
      },
      (error: unknown) => {
        this.#reading = false;
        this.#failed = true;
        this.#error = error;
        this.#closed.reject(error);
        for (const read of this.#waiting.splice(0)) read.reject(error);
      },
    );
  }

  cancel(reason: unknown): Promise<void> {
    return this.#failed ? Promise.reject(this.#error) : this.#cursor.cancel(reason);
  }

  closed(): Promise<undefined> {
    return this.#closed.promise;
  }

  release(): void {
    for (const read of this.#waiting.splice(0)) read.reject(released());
  }
}

const cursors = new WeakMap<ReadableStream<Uint8Array>, ShellInputCursor>();

export function shellInput(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (cursors.has(source)) return source;
  const cursor = new ShellInputCursor(source);
  const reads = new InputReads(cursor);
  let goNative = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        goNative();
        try {
          const result = await reads.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reads.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  // Commands read their input with `getReader()`, which reads the cursor
  // through `reads` instead of through this stream's pull.
  goNative = readDirectly(stream, reads);
  cursors.set(stream, cursor);
  return stream;
}

export async function readInputRecord(
  stream: ReadableStream<Uint8Array>,
  budget: ShellBudget,
  signal: AbortSignal,
): Promise<InputRecord> {
  const cursor = cursors.get(stream);
  if (cursor === undefined) throw new VfsError("EIO", "read requires a managed shell input stream");
  return await cursor.readRecord(budget, signal);
}
