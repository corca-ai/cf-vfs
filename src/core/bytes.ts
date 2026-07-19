import { VfsError } from "./errors.js";

export function copyArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return bytes.slice().buffer;
}

export function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}

export function headBytes(bytes: Uint8Array, maximum: number): Uint8Array {
  let end = Math.min(bytes.byteLength, Math.max(0, maximum));
  while (end > 0) {
    const result = bytes.slice(0, end);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(result);
      return result;
    } catch {
      end -= 1;
    }
  }
  return new Uint8Array();
}

export function tailBytes(bytes: Uint8Array, maximum: number): Uint8Array {
  let start = Math.max(0, bytes.byteLength - Math.max(0, maximum));
  while (start < bytes.byteLength) {
    const result = bytes.slice(start);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(result);
      return result;
    } catch {
      start += 1;
    }
  }
  return new Uint8Array();
}

export function headLines(bytes: Uint8Array, lines: number): Uint8Array {
  if (lines <= 0) return new Uint8Array();
  let seen = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a && ++seen === lines) return bytes.slice(0, index + 1);
  }
  return bytes;
}

export function tailLines(bytes: Uint8Array, lines: number): Uint8Array {
  if (lines <= 0) return new Uint8Array();
  let index = bytes.byteLength - 1;
  if (index >= 0 && bytes[index] === 0x0a) index -= 1;
  let seen = 0;
  for (; index >= 0; index -= 1) {
    if (bytes[index] === 0x0a && ++seen === lines) return bytes.slice(index + 1);
  }
  return bytes;
}

export function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VfsError("EIO", "stored text is not valid UTF-8", path);
  }
}
