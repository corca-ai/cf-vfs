import { VfsError } from "../core/errors.js";
import { validateByteRange } from "../vfs/range.js";
import type { ByteBody, ByteRange, OpaqueObjectMetadata, OpaqueStore } from "../vfs/types.js";

function opaqueMetadata(object: R2Object): OpaqueObjectMetadata {
  const verifiedSha256 = object.checksums.toJSON().sha256;
  return {
    key: object.key,
    sizeBytes: object.size,
    etag: object.etag,
    version: object.version,
    ...(object.httpMetadata?.contentType === undefined
      ? {}
      : { contentType: object.httpMetadata.contentType }),
    ...(verifiedSha256 === undefined ? {} : { verifiedSha256 }),
  };
}

/** Immutable, one-write R2 bodies for opaque VFS files. */
export class R2OpaqueStore implements OpaqueStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async putIfAbsent(
    key: string,
    body: ByteBody,
    metadata: { contentType?: string } = {},
  ): Promise<OpaqueObjectMetadata> {
    const object = await this.bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      ...(metadata.contentType === undefined
        ? {}
        : { httpMetadata: { contentType: metadata.contentType } }),
    });
    if (object === null) {
      throw new VfsError("EEXIST", "immutable R2 generation already exists", key);
    }
    return opaqueMetadata(object);
  }

  async head(key: string): Promise<OpaqueObjectMetadata | null> {
    const object = await this.bucket.head(key);
    return object === null ? null : opaqueMetadata(object);
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    validateByteRange(range, key);
    const object = await this.bucket.get(key, range === undefined ? undefined : { range });
    return object?.body ?? null;
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    await this.bucket.delete(typeof keys === "string" ? keys : [...keys]);
  }
}
