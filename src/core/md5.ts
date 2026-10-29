/**
 * Incremental MD5 (RFC 1321), for `md5sum`. Web Crypto has no MD5, and the
 * digest is only a checksum here, never a security property.
 */

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const CONSTANTS = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32),
);

export class Md5 {
  private state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  private readonly block = new Uint8Array(64);
  private filled = 0;
  private length = 0;

  update(bytes: Uint8Array): void {
    this.length += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const taken = Math.min(64 - this.filled, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + taken), this.filled);
      this.filled += taken;
      offset += taken;
      if (this.filled === 64) {
        this.compress();
        this.filled = 0;
      }
    }
  }

  /** Finishes the digest as lowercase hexadecimal; the instance is spent. */
  hex(): string {
    const bits = this.length * 8;
    this.update(new Uint8Array([0x80]));
    while (this.filled !== 56) this.update(new Uint8Array([0]));
    const trailer = new Uint8Array(8);
    const view = new DataView(trailer.buffer);
    view.setUint32(0, bits >>> 0, true);
    view.setUint32(4, Math.floor(bits / 2 ** 32), true);
    this.update(trailer);
    let hex = "";
    for (const word of this.state) {
      for (let shift = 0; shift < 32; shift += 8) {
        hex += ((word >>> shift) & 0xff).toString(16).padStart(2, "0");
      }
    }
    return hex;
  }

  private compress(): void {
    const view = new DataView(this.block.buffer);
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(index * 4, true));
    let [a, b, c, d] = this.state as [number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      let mixed: number;
      let word: number;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        word = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        word = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        word = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        word = (7 * index) % 16;
      }
      const rotated = (a + mixed + (CONSTANTS[index] ?? 0) + (words[word] ?? 0)) | 0;
      const shift = SHIFTS[index] ?? 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((rotated << shift) | (rotated >>> (32 - shift)))) | 0;
    }
    this.state = this.state.map((value, index) => (value + ([a, b, c, d][index] ?? 0)) | 0);
  }
}
