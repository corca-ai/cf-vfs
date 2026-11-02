import { expect } from "vitest";
import { shellInput } from "../../src/shell/input.js";
import { createBytePipe } from "../../src/shell/pipe.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

function pipe(maximumBytes = 1 << 20, extra: Partial<Parameters<typeof createBytePipe>[0]> = {}) {
  const abort = new AbortController();
  return {
    abort,
    ...createBytePipe({
      maximumBytes,
      signal: abort.signal,
      name: "p",
      ...extra,
    }),
  };
}

/** The pipe's contract, run in Node and in workerd. */
export const PIPE_CASES: Record<string, () => Promise<void>> = {
  "reads what was written, in order, then ends": async () => {
    const { readable, sink } = pipe();
    const reader = readable.getReader();
    const early = reader.read();
    await sink.write(bytes(1));
    await sink.write(bytes(2, 3));
    await sink.close();
    expect(await early).toEqual({ done: false, value: bytes(1) });
    expect(await reader.read()).toEqual({ done: false, value: bytes(2, 3) });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await expect(reader.closed).resolves.toBeUndefined();
  },

  "serves native consumers from the same queue": async () => {
    const first = pipe();
    void first.sink.write(bytes(104, 105)).then(() => first.sink.close());
    expect(await new Response(first.readable).text()).toBe("hi");

    const second = pipe();
    const reader = second.readable.getReader();
    await second.sink.write(bytes(1));
    expect((await reader.read()).value).toEqual(bytes(1));
    reader.releaseLock();
    await second.sink.write(bytes(2));
    await second.sink.close();
    const seen: Uint8Array[] = [];
    for await (const chunk of second.readable as unknown as AsyncIterable<Uint8Array>)
      seen.push(chunk);
    expect(seen).toEqual([bytes(2)]);

    const third = pipe();
    const written: Uint8Array[] = [];
    const piped = third.readable.pipeTo(
      new WritableStream({ write: (chunk) => void written.push(chunk) }),
    );
    await third.sink.write(bytes(7));
    await third.sink.close();
    await piped;
    expect(written).toEqual([bytes(7)]);
  },

  "locks as a stream does": async () => {
    const { readable } = pipe();
    const reader = readable.getReader();
    expect(readable.locked).toBe(true);
    expect(() => readable.getReader()).toThrow(TypeError);
    await expect(readable.pipeTo(new WritableStream())).rejects.toThrow(TypeError);
    const pending = reader.read();
    reader.releaseLock();
    await expect(pending).rejects.toThrow(TypeError);
    await expect(reader.read()).rejects.toThrow(TypeError);
    expect(readable.locked).toBe(false);
    readable.getReader();
  },

  "holds a writer once 64 KiB are queued, until a read makes room": async () => {
    const { readable, sink } = pipe();
    const reader = readable.getReader();
    let settled = false;
    const big = sink.write(new Uint8Array(64 * 1024 - 1)).then(() => (settled = true));
    await big;
    const full = sink.write(bytes(1)).then(() => (settled = true));
    settled = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    await reader.read();
    await full;
    expect(settled).toBe(true);
  },

  "ends the stream and fails the writer when the consumer cancels": async () => {
    const cancelled: unknown[] = [];
    const { readable, sink } = pipe(1 << 20, {
      onConsumerCancel: (reason) => cancelled.push(reason),
    });
    const reader = readable.getReader();
    await sink.write(bytes(1));
    const enough = new Error("enough");
    await reader.cancel(enough);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await expect(sink.write(bytes(2))).rejects.toBe(enough);
    await Promise.resolve();
    expect(cancelled).toEqual([enough]);

    const downstream = pipe();
    const nativeReader = downstream.readable.getReader();
    nativeReader.releaseLock();
    await downstream.readable.cancel();
    await expect(downstream.sink.write(bytes(1))).rejects.toMatchObject({
      code: "EPIPE",
    });
  },

  "fails reads with the cancellation when the execution aborts": async () => {
    const { abort, readable, sink } = pipe();
    const reader = readable.getReader();
    await sink.write(bytes(1));
    const reason = new Error("stop");
    abort.abort(reason);
    await expect(reader.read()).rejects.toBe(reason);
    await expect(reader.closed).rejects.toBe(reason);
    await expect(sink.write(bytes(2))).rejects.toBe(reason);
  },

  "fails the reader once the byte limit is passed": async () => {
    const { readable, sink } = pipe(3);
    const reader = readable.getReader();
    await sink.write(bytes(1, 2));
    await expect(sink.write(bytes(3, 4))).rejects.toMatchObject({
      code: "E2BIG",
    });
    await expect(reader.read()).rejects.toMatchObject({ code: "E2BIG" });
  },

  "errors native consumers when the writer aborts": async () => {
    const { readable, sink } = pipe();
    const text = new Response(readable).text();
    await sink.write(bytes(1));
    await sink.abort(new Error("gone"));
    await expect(text).rejects.toThrow("gone");
  },

  "loses nothing when a native read is abandoned before a reader takes over": async () => {
    const { readable, sink } = pipe();
    const native = ReadableStream.prototype.getReader.call(readable) as ReadableStreamDefaultReader;
    const abandoned = native.read();
    native.releaseLock();
    await expect(abandoned).rejects.toThrow(TypeError);
    const reader = readable.getReader();
    const first = reader.read();
    await sink.write(bytes(1));
    await sink.write(bytes(2));
    await sink.close();
    expect(await first).toEqual({ done: false, value: bytes(1) });
    expect(await reader.read()).toEqual({ done: false, value: bytes(2) });
    expect((await reader.read()).done).toBe(true);
  },

  "gives each reader its own closed promise, rejected on release": async () => {
    const { readable, sink } = pipe();
    const first = readable.getReader();
    const closed = first.closed;
    first.releaseLock();
    await expect(closed).rejects.toThrow(TypeError);
    const second = readable.getReader();
    expect(second.closed).not.toBe(closed);
    await sink.close();
    await expect(second.closed).resolves.toBeUndefined();
  },

  "fails a waiting write when another descriptor aborts the pipe": async () => {
    const { readable, sink } = pipe();
    readable.getReader();
    const other = sink.clone();
    const waiting = sink.write(new Uint8Array(70 * 1024));
    const reason = new Error("gone");
    await other.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  },

  "delivers no empty chunks": async () => {
    const { readable, sink } = pipe();
    const reader = readable.getReader();
    await sink.write(new Uint8Array(0));
    await sink.write(bytes(5));
    await sink.close();
    expect(await reader.read()).toEqual({ done: false, value: bytes(5) });
    expect((await reader.read()).done).toBe(true);
  },

  "errors a native consumer of a pipe that was already aborted": async () => {
    const abort = new AbortController();
    const reason = new Error("before");
    abort.abort(reason);
    const { readable } = createBytePipe({ maximumBytes: 64, signal: abort.signal, name: "p" });
    await expect(new Response(readable).text()).rejects.toBe(reason);
  },

  "reads a pipeline input through getReader and as a stream": async () => {
    const first = pipe();
    const input = shellInput(first.readable);
    const reader = input.getReader();
    await first.sink.write(bytes(1, 2));
    expect(await reader.read()).toEqual({ done: false, value: bytes(1, 2) });
    reader.releaseLock();
    await first.sink.write(bytes(3));
    await first.sink.close();
    const rest: Uint8Array[] = [];
    for await (const chunk of input as unknown as AsyncIterable<Uint8Array>) rest.push(chunk);
    expect(rest).toEqual([bytes(3)]);

    const second = pipe();
    const cancelled = shellInput(second.readable).getReader();
    await cancelled.cancel(new Error("enough"));
    await expect(second.sink.write(bytes(1))).rejects.toMatchObject({ code: "EPIPE" });
  },

  "answers overlapping reads of a pipeline input in order": async () => {
    const { readable, sink } = pipe();
    const reader = shellInput(readable).getReader();
    const reads = [reader.read(), reader.read()];
    await sink.write(bytes(1));
    await sink.write(bytes(2));
    expect(await Promise.all(reads)).toEqual([
      { done: false, value: bytes(1) },
      { done: false, value: bytes(2) },
    ]);
  },

  "keeps a chunk that arrives after its reader let go of a pipeline input": async () => {
    const { readable, sink } = pipe();
    const input = shellInput(readable);
    const first = input.getReader();
    const abandoned = first.read();
    first.releaseLock();
    await expect(abandoned).rejects.toThrow(TypeError);
    await sink.write(bytes(1));
    await sink.write(bytes(2));
    await sink.close();
    const second = input.getReader();
    expect(await second.read()).toEqual({ done: false, value: bytes(1) });
    expect(await second.read()).toEqual({ done: false, value: bytes(2) });
    expect((await second.read()).done).toBe(true);
  },

  "keeps failing a pipeline input once its source failed": async () => {
    const failure = new Error("broke");
    let fail: (error: unknown) => void = () => undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(1));
        fail = (error) => controller.error(error);
      },
    });
    const input = shellInput(source);
    const first = input.getReader();
    expect((await first.read()).value).toEqual(bytes(1));
    fail(failure);
    await expect(first.read()).rejects.toBe(failure);
    await expect(first.cancel()).rejects.toBe(failure);
    first.releaseLock();
    await expect(input.getReader().read()).rejects.toBe(failure);
  },

  "locks a pipe while a pipeline input reads it": async () => {
    const { readable, sink } = pipe();
    const reader = shellInput(readable).getReader();
    const pending = reader.read();
    expect(() => readable.getReader()).toThrow(TypeError);
    await sink.write(bytes(1));
    expect((await pending).value).toEqual(bytes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readable.getReader()).toBeInstanceOf(ReadableStreamDefaultReader);
  },

  "wakes a writer whenever a native read makes room": async () => {
    let idle = 0;
    const { readable, sink } = pipe(1 << 20, { idleTimeoutMs: 40, onIdle: () => (idle += 1) });
    const writing = (async () => {
      for (let index = 0; index < 120; index += 1) await sink.write(new Uint8Array(1024));
      await sink.close();
    })();
    let received = 0;
    await readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          received += chunk.byteLength;
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      }),
    );
    await writing;
    expect(received).toBe(120 * 1024);
    expect(idle).toBe(0);
  },
};
