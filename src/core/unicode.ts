const UTF8_ENCODER = new TextEncoder();

/** Encodes text with the package's shared UTF-8 encoder. */
export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return UTF8_ENCODER.encode(value);
}

/** Returns the number of bytes needed to encode `value` as UTF-8. */
export function utf8ByteLength(value: string): number {
  return encodeUtf8(value).byteLength;
}

export function firstCodePoint(value: string): number {
  return value.codePointAt(0) ?? 0;
}

export function codePointLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}
