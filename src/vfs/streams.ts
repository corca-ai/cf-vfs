import { VfsError } from "../core/errors.js";
import type { ByteBody } from "./types.js";

export interface CollectedBytes {
  chunks: Uint8Array[];
  sizeBytes: number;
}

function rawBodyBytes(body: Exclude<ByteBody, ReadableStream<Uint8Array>>): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function copyView(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

export function bodyToStream(body: ByteBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : copyView(body);
  return streamFromChunks(bytes.byteLength === 0 ? [] : [bytes]);
}

export function streamFromChunks(
  chunks: readonly Uint8Array[],
  onFinalize?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    onFinalize?.();
  };
  return new ReadableStream<Uint8Array>({
    type: "bytes",
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        finalize();
        controller.close();
        return;
      }
      controller.enqueue(chunk.slice());
    },
    cancel() {
      finalize();
    },
  });
}

export async function collectBytes(
  body: ByteBody,
  maximumBytes: number,
  account?: (delta: number) => void,
): Promise<CollectedBytes> {
  const reader = bodyToStream(body).getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const chunk = read.value.slice();
      sizeBytes += chunk.byteLength;
      account?.(chunk.byteLength);
      if (sizeBytes > maximumBytes) {
        throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
      }
      if (chunk.byteLength > 0) chunks.push(chunk);
    }
    return { chunks, sizeBytes };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Collects directly into fixed-size slabs, avoiding an intermediate copy before rechunking. */
export async function collectRechunkedBytes(
  body: ByteBody,
  maximumBytes: number,
  chunkBytes: number,
  account?: (delta: number) => void,
): Promise<CollectedBytes> {
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  let current = new Uint8Array(chunkBytes);
  let used = 0;

  const append = (input: Uint8Array): void => {
    sizeBytes += input.byteLength;
    account?.(input.byteLength);
    if (sizeBytes > maximumBytes) {
      throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
    }
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(current.byteLength - used, input.byteLength - offset);
      current.set(input.subarray(offset, offset + copied), used);
      offset += copied;
      used += copied;
      if (used === current.byteLength) {
        chunks.push(current);
        current = new Uint8Array(chunkBytes);
        used = 0;
      }
    }
  };

  if (!(body instanceof ReadableStream)) {
    append(rawBodyBytes(body));
    if (used > 0) chunks.push(current.slice(0, used));
    return { chunks, sizeBytes };
  }

  const reader = body.getReader();
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      append(read.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (used > 0) chunks.push(current.slice(0, used));
  return { chunks, sizeBytes };
}

export function rechunk(chunks: readonly Uint8Array[], chunkBytes: number): Uint8Array[] {
  const output: Uint8Array[] = [];
  let current = new Uint8Array(chunkBytes);
  let used = 0;
  for (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const copied = Math.min(chunkBytes - used, chunk.byteLength - offset);
      current.set(chunk.subarray(offset, offset + copied), used);
      used += copied;
      offset += copied;
      if (used === chunkBytes) {
        output.push(current);
        current = new Uint8Array(chunkBytes);
        used = 0;
      }
    }
  }
  if (used > 0) output.push(current.slice(0, used));
  return output;
}

export async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const collected = await collectBytes(stream, maximumBytes);
  const output = new Uint8Array(collected.sizeBytes);
  let offset = 0;
  for (const chunk of collected.chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readUtf8(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  path?: string,
): Promise<string> {
  const bytes = await readAllBytes(stream, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VfsError("EIO", "input is not valid UTF-8", path);
  }
}
