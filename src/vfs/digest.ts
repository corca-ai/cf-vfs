/** Reuses contiguous owned chunk views without joining another body-sized buffer. */
function contiguousBody(chunks: readonly Uint8Array[], sizeBytes: number): Uint8Array | undefined {
  const first = chunks[0];
  if (first === undefined) return undefined;
  let end = first.byteOffset;
  for (const chunk of chunks) {
    if (chunk.buffer !== first.buffer || chunk.byteOffset !== end) return undefined;
    end += chunk.byteLength;
  }
  return end - first.byteOffset === sizeBytes
    ? new Uint8Array(first.buffer, first.byteOffset, sizeBytes)
    : undefined;
}

/** Lowercase hexadecimal SHA-256 over one buffered body. */
export async function sha256Hex(chunks: readonly Uint8Array[], sizeBytes: number): Promise<string> {
  let source: Uint8Array;
  if (chunks.length === 1 && chunks[0] !== undefined) {
    source = chunks[0];
  } else {
    const contiguous = contiguousBody(chunks, sizeBytes);
    source = contiguous ?? new Uint8Array(sizeBytes);
    if (contiguous === undefined) {
      let offset = 0;
      for (const chunk of chunks) {
        source.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  }
  const digestInput: Uint8Array<ArrayBuffer> =
    source.buffer instanceof ArrayBuffer
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
