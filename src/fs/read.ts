import { VfsError } from "../core/errors.js";
import type { InFlightByteBudget } from "../vfs/buffering.js";
import type {
  ByteBody,
  InlineReadResult,
  OpaqueFileStat,
  WriteFileOptions,
  WriteResult,
} from "../vfs/types.js";

export interface FsContent {
  append?(path: string, body: string | Uint8Array): Promise<WriteResult | OpaqueFileStat>;
  open(
    path: string,
  ): Promise<InlineReadResult | { stat: OpaqueFileStat; stream: ReadableStream<Uint8Array> }>;
  write(
    path: string,
    body: ByteBody,
    options?: WriteFileOptions,
  ): Promise<WriteResult | OpaqueFileStat>;
}

/** One bounded output allocation, with no intermediate per-chunk clones. */
export async function materialize(
  opened: InlineReadResult | { stat: OpaqueFileStat; stream: ReadableStream<Uint8Array> },
  maximum: number,
  budget: InFlightByteBudget,
): Promise<Uint8Array<ArrayBuffer>> {
  const { stat, stream } = opened;
  try {
    if (stat.sizeBytes > maximum)
      throw new VfsError("EFBIG", "readFile exceeds its materialization limit", stat.path);
    budget.acquire(stat.sizeBytes);
  } catch (error) {
    await stream.cancel(error).catch(() => undefined);
    throw error;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch (error) {
    budget.release(stat.sizeBytes);
    throw error;
  }
  try {
    const bytes = new Uint8Array(stat.sizeBytes);
    let offset = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > bytes.byteLength)
        throw new VfsError("EIO", "file exceeds its reported size", stat.path);
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== bytes.byteLength)
      throw new VfsError("EIO", "file is shorter than its reported size", stat.path);
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    budget.release(stat.sizeBytes);
  }
}
