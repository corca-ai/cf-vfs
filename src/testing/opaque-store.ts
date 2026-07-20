import { VfsError } from "../core/errors.js";
import { collectBytes, streamFromChunks } from "../vfs/streams.js";
import type {
  ByteBody,
  ByteRange,
  OpaqueObjectMetadata,
  OpaqueStore,
} from "../vfs/types.js";

interface StoredObject {
  metadata: OpaqueObjectMetadata;
  chunks: Uint8Array[];
}

function rangeChunks(chunks: readonly Uint8Array[], range: ByteRange | undefined): Uint8Array[] {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let writeOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  if (range === undefined) return [bytes];
  if (range.suffix !== undefined) return [bytes.slice(Math.max(0, size - range.suffix))];
  const offset = range.offset ?? 0;
  return [bytes.slice(offset, range.length === undefined ? size : offset + range.length)];
}

export class MemoryOpaqueStore implements OpaqueStore {
  private readonly objects = new Map<string, StoredObject>();
  private readonly pending = new Set<string>();
  private readonly verifySha256: boolean;
  private version = 1;
  readonly operations = {
    puts: 0,
    heads: 0,
    gets: 0,
    deleteRequests: 0,
    deletedKeys: 0,
  };

  constructor(options: { verifySha256?: boolean } = {}) {
    this.verifySha256 = options.verifySha256 ?? false;
  }

  async putIfAbsent(
    key: string,
    body: ByteBody,
    metadata: { contentType?: string } = {},
  ): Promise<OpaqueObjectMetadata> {
    this.operations.puts += 1;
    if (this.objects.has(key) || this.pending.has(key)) {
      throw new VfsError("EEXIST", "immutable object already exists", key);
    }
    this.pending.add(key);
    try {
      const collected = await collectBytes(body, Number.MAX_SAFE_INTEGER);
      const etag = `memory-${this.version}`;
      let verifiedSha256: string | undefined;
      if (this.verifySha256) {
        const bytes = new Uint8Array(collected.sizeBytes);
        let offset = 0;
        for (const chunk of collected.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        verifiedSha256 = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      }
      const objectMetadata: OpaqueObjectMetadata = {
        key,
        sizeBytes: collected.sizeBytes,
        etag,
        version: String(this.version++),
        ...(metadata.contentType === undefined ? {} : { contentType: metadata.contentType }),
        ...(verifiedSha256 === undefined ? {} : { verifiedSha256 }),
      };
      this.objects.set(key, {
        metadata: objectMetadata,
        chunks: collected.chunks.map((chunk) => chunk.slice()),
      });
      return { ...objectMetadata };
    } finally {
      this.pending.delete(key);
    }
  }

  head(key: string): Promise<OpaqueObjectMetadata | null> {
    this.operations.heads += 1;
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : { ...object.metadata });
  }

  getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    this.operations.gets += 1;
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined
      ? null
      : streamFromChunks(rangeChunks(object.chunks, range)));
  }

  delete(keys: string | readonly string[]): Promise<void> {
    const values = typeof keys === "string" ? [keys] : keys;
    this.operations.deleteRequests += 1;
    this.operations.deletedKeys += values.length;
    for (const key of values) this.objects.delete(key);
    return Promise.resolve();
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
