import { VfsError } from "../core/errors.js";
import { encodeUtf8 } from "../core/unicode.js";
import type { ByteBody } from "./types.js";

export interface CollectedBytes {
  chunks: Uint8Array[];
  sizeBytes: number;
}

function rawBodyBytes(body: Exclude<ByteBody, ReadableStream<Uint8Array>>): Uint8Array {
  if (typeof body === "string") return encodeUtf8(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function copyView(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

export function bodyToStream(body: ByteBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  const bytes = typeof body === "string" ? encodeUtf8(body) : copyView(body);
  return streamFromChunks(bytes.byteLength === 0 ? [] : [bytes]);
}

export function streamFromChunks(
  chunks: readonly Uint8Array[],
  onFinalize?: () => void,
): ReadableStream<Uint8Array> {
  return chunkStream(chunks, (chunk) => chunk.slice(), onFinalize);
}

/** Transfers private chunks into a byte stream without cloning them first. */
export function streamFromOwnedChunks(
  chunks: readonly Uint8Array<ArrayBuffer>[],
  onFinalize?: () => void,
): ReadableStream<Uint8Array> {
  return chunkStream(chunks, (chunk) => chunk, onFinalize);
}

function chunkStream<Buffer extends ArrayBufferLike>(
  chunks: readonly Uint8Array<Buffer>[],
  take: (chunk: Uint8Array<Buffer>) => Uint8Array<ArrayBuffer>,
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
      controller.enqueue(take(chunk));
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

function collectMaterialized(
  body: Exclude<ByteBody, ReadableStream<Uint8Array>>,
  materialized: Uint8Array,
  maximumBytes: number,
  chunkBytes: number,
  account?: (delta: number) => void,
): CollectedBytes | undefined {
  if (materialized.byteLength > chunkBytes && materialized.byteLength <= maximumBytes) {
    return undefined;
  }
  const sizeBytes = materialized.byteLength;
  account?.(sizeBytes);
  if (sizeBytes > maximumBytes) {
    throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
  }
  return {
    chunks: sizeBytes === 0 ? [] : [typeof body === "string" ? materialized : materialized.slice()],
    sizeBytes,
  };
}

async function consumeByteStream(
  stream: ReadableStream<Uint8Array>,
  append: (chunk: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) return;
      append(read.value);
    }
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
  let materialized: Uint8Array | undefined;
  if (!(body instanceof ReadableStream)) {
    materialized = rawBodyBytes(body);
    const collected = collectMaterialized(body, materialized, maximumBytes, chunkBytes, account);
    if (collected !== undefined) return collected;
  }
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
    if (materialized === undefined) throw new TypeError("materialized body is missing");
    append(materialized);
    if (used > 0) chunks.push(current.slice(0, used));
    return { chunks, sizeBytes };
  }

  await consumeByteStream(body, append);
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
  const only = collected.chunks[0];
  if (only !== undefined && collected.chunks.length === 1) return only;
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
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let sizeBytes = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      sizeBytes += read.value.byteLength;
      if (sizeBytes > maximumBytes) {
        throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
      }
      try {
        const decoded = decoder.decode(read.value, { stream: true });
        if (decoded.length > 0) chunks.push(decoded);
      } catch {
        throw new VfsError("EIO", "input is not valid UTF-8", path);
      }
    }
    try {
      const final = decoder.decode();
      if (final.length > 0) chunks.push(final);
    } catch {
      throw new VfsError("EIO", "input is not valid UTF-8", path);
    }
    return chunks.join("");
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
