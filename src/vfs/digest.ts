/** Lowercase hexadecimal SHA-256 over one buffered body. */
export async function sha256Hex(chunks: readonly Uint8Array[], sizeBytes: number): Promise<string> {
  let source: Uint8Array;
  if (chunks.length === 1 && chunks[0] !== undefined) {
    source = chunks[0];
  } else {
    source = new Uint8Array(sizeBytes);
    let offset = 0;
    for (const chunk of chunks) {
      source.set(chunk, offset);
      offset += chunk.byteLength;
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
