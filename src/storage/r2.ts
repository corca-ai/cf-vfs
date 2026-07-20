import { VfsError } from "../core/errors.js";
import type {
  ByteBody,
  ByteRange,
  OpaqueObjectMetadata,
  OpaqueStore,
} from "../vfs/types.js";

function isRangeRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRange(key: string, range: unknown): asserts range is ByteRange | undefined {
  if (range === undefined) return;
  if (!isRangeRecord(range)) throw new VfsError("EINVAL", "byte range must be an object", key);
  const entries = Object.entries(range);
  for (const [name, value] of entries) {
    if (name !== "offset" && name !== "length" && name !== "suffix") {
      throw new VfsError("EINVAL", `unknown byte range field: ${name}`, key);
    }
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < 0
      || (name !== "offset" && value === 0)
    ) {
      throw new VfsError(
        "EINVAL",
        `${name} must be ${name === "offset" ? "a non-negative" : "a positive"} integer`,
        key,
      );
    }
  }
  const hasOffset = "offset" in range;
  const hasLength = "length" in range;
  const hasSuffix = "suffix" in range;
  if ((!hasOffset && !hasLength && !hasSuffix) || (hasSuffix && (hasOffset || hasLength))) {
    throw new VfsError("EINVAL", "byte range must use offset/length or suffix", key);
  }
}

function checksumHex(value: ArrayBuffer | undefined): string | undefined {
  if (value === undefined) return undefined;
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function opaqueMetadata(object: R2Object): OpaqueObjectMetadata {
  const verifiedSha256 = checksumHex(object.checksums.sha256);
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

  async getStream(
    key: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array> | null> {
    validateRange(key, range);
    const object = await this.bucket.get(key, range === undefined ? undefined : { range });
    return object?.body ?? null;
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    await this.bucket.delete(typeof keys === "string" ? keys : [...keys]);
  }
}
