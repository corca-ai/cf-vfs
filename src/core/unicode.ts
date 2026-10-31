const UTF8_ENCODER = new TextEncoder();

/** Encodes text with the package's shared UTF-8 encoder. */
export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return UTF8_ENCODER.encode(value);
}

const NON_ASCII = /[\u0080-\u{10ffff}]/u;

/** Returns the number of bytes needed to encode `value` as UTF-8. */
export function utf8ByteLength(value: string): number {
  // ASCII text is its own length. On Workers encoding allocates a buffer per
  // call and costs about seven times the scan for a 200-character line, so
  // only text that is not ASCII is encoded to be measured.
  return NON_ASCII.test(value) ? encodeUtf8(value).byteLength : value.length;
}

export function firstCodePoint(value: string): number {
  return value.codePointAt(0) ?? 0;
}

export function codePointLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

/** Slice non-negative code-point positions without materializing a character array. */
export function sliceCodePoints(
  value: string,
  start: number,
  end = Number.POSITIVE_INFINITY,
): string {
  const first = Number.isNaN(start) ? 0 : start;
  const last = Number.isNaN(end) ? 0 : end;
  if (last <= first) return "";
  let point = 0;
  let offset = 0;
  let from = value.length;
  for (const character of value) {
    if (point === first) from = offset;
    if (point >= last) break;
    offset += character.length;
    point += 1;
  }
  return value.slice(from, offset);
}
