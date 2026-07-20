import { VfsError } from "../core/errors.js";
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
    const reader = this.source.getReader();
    const cancelled = (): VfsError => signal?.reason instanceof VfsError
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
        void reader.read().then(resolve, reject).finally(() => {
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
        budget.io(consumedBytes);
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

const cursors = new WeakMap<ReadableStream<Uint8Array>, ShellInputCursor>();

export function shellInput(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (cursors.has(source)) return source;
  const cursor = new ShellInputCursor(source);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await cursor.readChunk();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cursor.cancel(reason);
    },
  }, { highWaterMark: 0 });
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
