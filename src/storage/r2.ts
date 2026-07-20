import { copyArrayBuffer } from "../core/bytes.js";
import { VfsError } from "../core/errors.js";
import type { BinaryRange, BinaryStore } from "../core/types.js";

function isRangeRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRange(key: string, range: unknown): asserts range is BinaryRange | undefined {
  if (range === undefined) return;
  if (!isRangeRecord(range)) {
    throw new VfsError("EINVAL", "binary range must be an object", key);
  }
  const entries = Object.entries(range);
  for (const [name, value] of entries) {
    if (name !== "offset" && name !== "length" && name !== "suffix") {
      throw new VfsError("EINVAL", `unknown binary range field: ${name}`, key);
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
  if (
    (!hasOffset && !hasLength && !hasSuffix)
    || (hasSuffix && (hasOffset || hasLength))
  ) {
    throw new VfsError("EINVAL", "binary range must use offset/length or suffix", key);
  }
}

export class R2BinaryStore implements BinaryStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  ): Promise<{ size: number }> {
    const object = await this.bucket.put(key, value);
    if (!object) throw new VfsError("EIO", "R2 rejected the conditional write", key);
    return { size: object.size };
  }

  async get(key: string, range?: BinaryRange): Promise<ArrayBuffer | null> {
    validateRange(key, range);
    const object = await this.bucket.get(key, range ? { range } : undefined);
    if (!object) return null;
    return copyArrayBuffer(await object.bytes());
  }

  async getStream(
    key: string,
    range?: BinaryRange,
  ): Promise<ReadableStream<Uint8Array> | null> {
    validateRange(key, range);
    const object = await this.bucket.get(key, range ? { range } : undefined);
    if (!object) return null;
    return object.body;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
