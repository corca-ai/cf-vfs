import { VfsError } from "../core/errors.js";
import type { ByteRange } from "./types.js";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRange(name: string, value: unknown): boolean {
  const minimum = name === "offset" ? 0 : 1;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Validates the byte-range shape shared by inline SQLite and opaque R2 reads. */
export function validateByteRange(
  range: unknown,
  path?: string,
): asserts range is ByteRange | undefined {
  if (range === undefined) return;
  if (!isRecord(range)) throw new VfsError("EINVAL", "byte range must be an object", path);
  for (const [name, value] of Object.entries(range)) {
    const known = ["offset", "length", "suffix"].includes(name);
    if (!known) throw new VfsError("EINVAL", `unknown byte range field: ${name}`, path);
    if (!validRange(name, value)) {
      const constraint = name === "offset" ? "a non-negative" : "a positive";
      throw new VfsError("EINVAL", `${name} must be ${constraint} integer`, path);
    }
  }
  const hasOffset = Object.hasOwn(range, "offset");
  const hasLength = Object.hasOwn(range, "length");
  const hasSuffix = Object.hasOwn(range, "suffix");
  if (!hasOffset && !hasLength && !hasSuffix) {
    throw new VfsError("EINVAL", "byte range must use offset/length or suffix", path);
  }
  if (hasSuffix && (hasOffset || hasLength)) {
    throw new VfsError("EINVAL", "byte range must use offset/length or suffix", path);
  }
}

/** Resolves a valid range against one immutable body, clamped at EOF. */
export function byteRangeBounds(
  range: ByteRange | undefined,
  sizeBytes: number,
  path?: string,
): { offset: number; length: number } {
  validateByteRange(range, path);
  if (range === undefined) return { offset: 0, length: sizeBytes };
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, sizeBytes);
    return { offset: sizeBytes - length, length };
  }
  const offset = Math.min(range.offset ?? 0, sizeBytes);
  return {
    offset,
    length: Math.min(range.length ?? sizeBytes - offset, sizeBytes - offset),
  };
}
