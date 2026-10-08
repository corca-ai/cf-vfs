import { VfsError } from "../core/errors.js";

export function bytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}
export function position(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new VfsError("EINVAL", "invalid file position");
  return value;
}
