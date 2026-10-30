import { isLetterOrDigit, isWhiteSpace, splitWhitespace } from "./awiki-text.js";

/**
 * Text fingerprints for `suggest`'s near-duplicate pass, as the native tool
 * computes them: 64-bit FNV-1a over the UTF-8 of each character n-gram, held
 * here as interleaved 32-bit halves `[lo0, hi0, lo1, hi1, …]`.
 */

const WINNOW_GRAM = 5;
const WINNOW_WINDOW = 8;
const MAX_POSTING = 64;
const PUNCTUATION = new Set([..."[]()*_#>!|-"]);

/** One typed-array element; indices here are always in range. */
function at(array: ArrayLike<number>, index: number): number {
  return array[index] ?? 0;
}

/** What each ASCII character becomes in duplicate text: nothing, a space or itself lowercased. */
const ASCII = Array.from({ length: 0x80 }, (_, code) => {
  const character = String.fromCharCode(code);
  if (PUNCTUATION.has(character) || /^[\t\n\v\f\r ]$/u.test(character)) return " ";
  return /^[A-Za-z0-9]$/u.test(character) ? character.toLowerCase() : "";
});

function normalized(character: string): string {
  const code = character.charCodeAt(0);
  if (code < 0x80) return ASCII[code] ?? "";
  if (isLetterOrDigit(character)) return character.toLowerCase();
  return isWhiteSpace(character) ? " " : "";
}

export function normalizeDuplicateText(value: string): string {
  let out = "";
  let inCode = false;
  for (const character of value) {
    if (character === "`") inCode = !inCode;
    else if (!inCode) out += normalized(character);
  }
  return splitWhitespace(out).join(" ");
}

const ENCODER = new TextEncoder();

/** A text's UTF-8 bytes and where each code point starts, with the end appended. */
interface Utf8Text {
  readonly bytes: Uint8Array;
  readonly starts: Uint32Array;
  readonly cjk: number;
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function utf8Text(value: string): Utf8Text {
  const bytes = ENCODER.encode(value);
  const starts: number[] = [];
  bytes.forEach((byte, index) => {
    if ((byte & 0xc0) !== 0x80) starts.push(index);
  });
  starts.push(bytes.length);
  let cjk = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (isCjk(value.charCodeAt(index))) cjk += 1;
  }
  return { bytes, starts: Uint32Array.from(starts), cjk };
}

function gramSize(text: Utf8Text): number {
  return text.cjk * 3 > text.starts.length - 1 ? 3 : 5;
}

/** 64-bit hashes of every `n`-code-point window. */
function gramHashes(text: Utf8Text, n: number): Uint32Array {
  const { bytes, starts } = text;
  const points = starts.length - 1;
  const count = Math.max(points - n + 1, 0);
  const out = new Uint32Array(count * 2);
  for (let start = 0; start < count; start += 1) {
    let hi = 0xcbf29ce4;
    let lo = 0x84222325;
    const end = at(starts, start + n);
    for (let index = at(starts, start); index < end; index += 1) {
      lo = (lo ^ at(bytes, index)) >>> 0;
      // (hi:lo) * 0x100000001b3, modulo 2^64.
      const low = lo * 0x1b3;
      hi = (Math.imul(hi, 0x1b3) + Math.floor(low / 0x100000000) + (lo << 8)) >>> 0;
      lo = low >>> 0;
    }
    out[start * 2] = lo;
    out[start * 2 + 1] = hi;
  }
  return out;
}

/** Sorted, distinct 64-bit values. */
function sortedSet(halves: Uint32Array): Uint32Array {
  const wide = new BigUint64Array(halves.buffer, halves.byteOffset, halves.length / 2);
  wide.sort();
  let kept = 0;
  for (const value of wide) {
    if (kept > 0 && value === wide[kept - 1]) continue;
    wide[kept] = value;
    kept += 1;
  }
  return halves.subarray(0, kept * 2);
}

/** Orders element `i` of `a` against element `j` of `b` as unsigned 64-bit values. */
function compareAt(a: Uint32Array, i: number, b: Uint32Array, j: number): number {
  const high = at(a, i * 2 + 1) - at(b, j * 2 + 1);
  return high !== 0 ? high : at(a, i * 2) - at(b, j * 2);
}

/** Window minima of the 5-gram hashes, sorted and distinct. */
function winnow(grams: Uint32Array): Uint32Array {
  const count = grams.length / 2;
  if (count === 0) return grams;
  const windows = Math.max(count - WINNOW_WINDOW + 1, 1);
  const width = Math.min(count, WINNOW_WINDOW);
  const out = new Uint32Array(windows * 2);
  for (let start = 0; start < windows; start += 1) {
    let best = start;
    for (let index = start + 1; index < start + width; index += 1) {
      if (compareAt(grams, index, grams, best) < 0) best = index;
    }
    out[start * 2] = at(grams, best * 2);
    out[start * 2 + 1] = at(grams, best * 2 + 1);
  }
  return sortedSet(out);
}

export interface Fingerprint {
  readonly shingles: Uint32Array;
  readonly winnow: Uint32Array;
}

/** A page's shingle set and winnowed fingerprints, hashing its 5-grams once. */
export function fingerprint(norm: string): Fingerprint {
  const text = utf8Text(norm);
  const grams = gramHashes(text, WINNOW_GRAM);
  const size = gramSize(text);
  const shingleHashes = size === WINNOW_GRAM ? grams.slice() : gramHashes(text, size);
  return { shingles: sortedSet(shingleHashes), winnow: winnow(grams) };
}

export function shingles(norm: string): Uint32Array {
  const text = utf8Text(norm);
  return sortedSet(gramHashes(text, gramSize(text)));
}

export function setSize(set: Uint32Array): number {
  return set.length / 2;
}

/** Shared values of two sets, with the Jaccard, containment and size ratios. */
export function relation(a: Uint32Array, b: Uint32Array) {
  const lengthA = setSize(a);
  const lengthB = setSize(b);
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < lengthA && j < lengthB) {
    const order = compareAt(a, i, b, j);
    if (order <= 0) i += 1;
    if (order >= 0) j += 1;
    if (order === 0) shared += 1;
  }
  const smaller = Math.min(lengthA, lengthB);
  const larger = Math.max(lengthA, lengthB);
  const union = lengthA + lengthB - shared;
  return {
    jaccard: union === 0 ? 0 : shared / union,
    containment: smaller === 0 ? 0 : shared / smaller,
    shared,
    sizeRatio: smaller === 0 ? 0 : smaller / larger,
  };
}

const RADIX_PASSES = [
  [0, 0],
  [0, 16],
  [1, 0],
  [1, 16],
] as const;

/** A stable order of entries by 64-bit value, by four 16-bit counting passes. */
function radixOrder(values: Uint32Array, count: number): Uint32Array {
  let order = new Uint32Array(count);
  let next = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) order[index] = index;
  const buckets = new Uint32Array(65537);
  for (const [word, shift] of RADIX_PASSES) {
    const digit = (entry: number) => (at(values, entry * 2 + word) >>> shift) & 0xffff;
    buckets.fill(0);
    for (let index = 0; index < count; index += 1) {
      const bucket = digit(index) + 1;
      buckets[bucket] = at(buckets, bucket) + 1;
    }
    for (let bucket = 1; bucket < buckets.length; bucket += 1) {
      buckets[bucket] = at(buckets, bucket) + at(buckets, bucket - 1);
    }
    for (const entry of order) {
      const bucket = digit(entry);
      next[at(buckets, bucket)] = entry;
      buckets[bucket] = at(buckets, bucket) + 1;
    }
    [order, next] = [next, order];
  }
  return order;
}

/** Counts one pair per two pages of a posting list. */
function countPosting(
  owners: readonly number[],
  posting: Uint32Array,
  pages: number,
  counts: Map<number, number>,
): void {
  for (let i = 0; i < posting.length; i += 1) {
    for (let j = i + 1; j < posting.length; j += 1) {
      const a = at(owners, at(posting, i));
      const b = at(owners, at(posting, j));
      const key = Math.min(a, b) * pages + Math.max(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
}

/**
 * Adds, per pair of pages, how many winnowed values they share. A value held
 * by more than 64 pages is boilerplate and counts for nobody.
 */
export function countSharedWinnows(
  values: Uint32Array,
  owners: readonly number[],
  pages: number,
  counts: Map<number, number>,
): void {
  const count = owners.length;
  const order = radixOrder(values, count);
  let start = 0;
  while (start < count) {
    let end = start + 1;
    while (end < count && compareAt(values, at(order, end), values, at(order, start)) === 0) {
      end += 1;
    }
    if (end - start >= 2 && end - start <= MAX_POSTING) {
      countPosting(owners, order.subarray(start, end), pages, counts);
    }
    start = end;
  }
}

/** Appends the values of `set` that fall in `partition` of `partitions`. */
export function partitionEntries(
  set: Uint32Array,
  owner: number,
  partitions: number,
  partition: number,
  entries: number[],
  owners: number[],
): void {
  for (let index = 0; index < setSize(set); index += 1) {
    const lo = at(set, index * 2);
    if ((lo & (partitions - 1)) !== partition) continue;
    entries.push(lo, at(set, index * 2 + 1));
    owners.push(owner);
  }
}
