import { copyArrayBuffer } from "../core/bytes.js";
import { VfsError } from "../core/errors.js";
import type { BinaryRange, BinaryStore } from "../core/types.js";

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
    if (range) {
      for (const [name, value] of Object.entries(range)) {
        if (!Number.isInteger(value) || value < 0 || (name !== "offset" && value === 0)) {
          throw new VfsError(
            "EINVAL",
            `${name} must be ${name === "offset" ? "a non-negative" : "a positive"} integer`,
            key,
          );
        }
      }
    }
    const object = await this.bucket.get(key, range ? { range } : undefined);
    if (!object) return null;
    return copyArrayBuffer(await object.bytes());
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
