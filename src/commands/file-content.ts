import type { CommandContext } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import type { VfsStat } from "../core/types.js";
import { commandPath } from "./common.js";

export interface FileByteStream {
  path: string;
  stat: VfsStat;
  stream: ReadableStream<Uint8Array>;
}

export async function readFileByteStream(
  context: CommandContext,
  requested: string,
  maximumBytes: number,
): Promise<FileByteStream> {
  const path = commandPath(context, requested);
  const stat = await context.fileSystem.stat(path);
  if (stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", stat.path);
  if (stat.sizeBytes > maximumBytes) {
    throw new VfsError("E2BIG", `file exceeds the ${maximumBytes}-byte limit`, stat.path);
  }
  if (stat.contentKind === "text") {
    const read = await context.fileSystem.readText(path);
    if (read.stat.sizeBytes > maximumBytes) {
      throw new VfsError("E2BIG", `file exceeds the ${maximumBytes}-byte limit`, read.stat.path);
    }
    const bytes = new TextEncoder().encode(read.text);
    return { path: read.stat.path, stat: read.stat, stream: new Blob([bytes]).stream() };
  }
  const readBinaryStream = context.fileSystem.readBinaryStream;
  if (!readBinaryStream) {
    throw new VfsError("ENOTSUP", "binary streaming is not supported by this filesystem", stat.path);
  }
  const read = await readBinaryStream.call(context.fileSystem, path);
  if (read.stat.sizeBytes > maximumBytes) {
    await read.stream.cancel("file exceeds command byte limit");
    throw new VfsError("E2BIG", `file exceeds the ${maximumBytes}-byte limit`, read.stat.path);
  }
  return { path: read.stat.path, stat: read.stat, stream: read.stream };
}

export interface StreamComparison {
  equal: boolean;
  bytesCompared: number;
  firstDifferenceByte: number | null;
  firstDifferenceLine: number | null;
}

async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array | null> {
  for (;;) {
    const result = await reader.read();
    if (result.done) return null;
    if (result.value.byteLength > 0) return result.value;
  }
}

export async function compareByteStreams(
  left: ReadableStream<Uint8Array>,
  right: ReadableStream<Uint8Array>,
): Promise<StreamComparison> {
  const leftReader = left.getReader();
  const rightReader = right.getReader();
  let leftChunk: Uint8Array | null = null;
  let rightChunk: Uint8Array | null = null;
  let leftOffset = 0;
  let rightOffset = 0;
  let bytesCompared = 0;
  let line = 1;

  try {
    leftChunk = await nextChunk(leftReader);
    rightChunk = await nextChunk(rightReader);
    for (;;) {
      if (leftChunk === null || rightChunk === null) {
        const equal = leftChunk === null && rightChunk === null;
        if (!equal) await Promise.allSettled([leftReader.cancel(), rightReader.cancel()]);
        return {
          equal,
          bytesCompared,
          firstDifferenceByte: equal ? null : bytesCompared + 1,
          firstDifferenceLine: equal ? null : line,
        };
      }
      const length = Math.min(
        leftChunk.byteLength - leftOffset,
        rightChunk.byteLength - rightOffset,
      );
      for (let index = 0; index < length; index += 1) {
        const leftByte = leftChunk[leftOffset + index];
        const rightByte = rightChunk[rightOffset + index];
        if (leftByte !== rightByte) {
          await Promise.allSettled([leftReader.cancel(), rightReader.cancel()]);
          return {
            equal: false,
            bytesCompared,
            firstDifferenceByte: bytesCompared + 1,
            firstDifferenceLine: line,
          };
        }
        bytesCompared += 1;
        if (leftByte === 0x0a) line += 1;
      }
      leftOffset += length;
      rightOffset += length;
      if (leftOffset === leftChunk.byteLength) {
        leftChunk = await nextChunk(leftReader);
        leftOffset = 0;
      }
      if (rightOffset === rightChunk.byteLength) {
        rightChunk = await nextChunk(rightReader);
        rightOffset = 0;
      }
    }
  } catch (error) {
    await Promise.allSettled([leftReader.cancel(), rightReader.cancel()]);
    throw error;
  } finally {
    leftReader.releaseLock();
    rightReader.releaseLock();
  }
}

export function hexDigest(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
