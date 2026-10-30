/**
 * The sampler `awiki` seeds for path statistics: rand 0.8's `StdRng`
 * (ChaCha12 from rand_chacha 0.3) seeded with `seed_from_u64`, drawing
 * `gen_range(0..n)` for `usize`. Reproducing it makes a seeded sample pick
 * the same document pairs the native tool picks.
 */

const MASK64 = (1n << 64n) - 1n;

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function quarter(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  let [x, y, z, w] = [state[a] ?? 0, state[b] ?? 0, state[c] ?? 0, state[d] ?? 0];
  x = (x + y) >>> 0;
  w = rotl(w ^ x, 16);
  z = (z + w) >>> 0;
  y = rotl(y ^ z, 12);
  x = (x + y) >>> 0;
  w = rotl(w ^ x, 8);
  z = (z + w) >>> 0;
  y = rotl(y ^ z, 7);
  state[a] = x;
  state[b] = y;
  state[c] = z;
  state[d] = w;
}

/** rand_core's `seed_from_u64`: PCG32 output words fill the 32-byte seed. */
function seedWords(seed: bigint): Uint32Array {
  const words = new Uint32Array(8);
  let state = seed & MASK64;
  for (let index = 0; index < 8; index += 1) {
    state = (state * 6364136223846793005n + 11634580027462260723n) & MASK64;
    const xorshifted = Number((((state >> 18n) ^ state) >> 27n) & 0xffffffffn);
    const rotation = Number(state >> 59n);
    words[index] = ((xorshifted >>> rotation) | (xorshifted << ((32 - rotation) & 31))) >>> 0;
  }
  return words;
}

class StdRng {
  private readonly input = new Uint32Array(16);
  private readonly results = new Uint32Array(64);
  private index = 64;

  constructor(seed: bigint) {
    this.input.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
    this.input.set(seedWords(seed), 4);
  }

  private refill(): void {
    const working = new Uint32Array(16);
    for (let block = 0; block < 4; block += 1) {
      working.set(this.input);
      for (let round = 0; round < 6; round += 1) {
        quarter(working, 0, 4, 8, 12);
        quarter(working, 1, 5, 9, 13);
        quarter(working, 2, 6, 10, 14);
        quarter(working, 3, 7, 11, 15);
        quarter(working, 0, 5, 10, 15);
        quarter(working, 1, 6, 11, 12);
        quarter(working, 2, 7, 8, 13);
        quarter(working, 3, 4, 9, 14);
      }
      for (let word = 0; word < 16; word += 1) {
        this.results[block * 16 + word] = ((working[word] ?? 0) + (this.input[word] ?? 0)) >>> 0;
      }
      this.input[12] = ((this.input[12] ?? 0) + 1) >>> 0;
      if (this.input[12] === 0) this.input[13] = ((this.input[13] ?? 0) + 1) >>> 0;
    }
    this.index = 0;
  }

  nextU64(): bigint {
    if (this.index >= 64) this.refill();
    const low = BigInt(this.results[this.index] ?? 0);
    const high = BigInt(this.results[this.index + 1] ?? 0);
    this.index += 2;
    return (high << 32n) | low;
  }

  /** `gen_range(0..bound)` for a 64-bit `usize`, with rand 0.8's widening-multiply rejection. */
  below(bound: number): number {
    const range = BigInt(bound);
    const leadingZeros = 64 - range.toString(2).length;
    const zone = ((range << BigInt(leadingZeros)) & MASK64) - 1n;
    for (;;) {
      const product = this.nextU64() * range;
      if ((product & MASK64) <= zone) return Number(product >> 64n);
    }
  }
}

/** Distinct document pairs `(i, j)`, `i < j`, as `sample_component_pairs` draws them. */
export function sampleComponentPairs(
  nodeCount: number,
  sampleCount: number,
  seed: bigint,
): [number, number][] {
  const totalPairs = (nodeCount * (nodeCount - 1)) / 2;
  const pairs: [number, number][] = [];
  if (sampleCount >= totalPairs) {
    for (let i = 0; i < nodeCount; i += 1) {
      for (let j = i + 1; j < nodeCount; j += 1) pairs.push([i, j]);
    }
    return pairs;
  }
  const rng = new StdRng(seed);
  const seen = new Set<number>();
  while (pairs.length < sampleCount) {
    let i = rng.below(nodeCount);
    let j = rng.below(nodeCount - 1);
    if (j >= i) j += 1;
    if (i > j) [i, j] = [j, i];
    const key = i * nodeCount + j;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push([i, j]);
    }
  }
  return pairs;
}
