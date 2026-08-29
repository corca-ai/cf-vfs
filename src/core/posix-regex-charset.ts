export interface PosixCharSet {
  readonly negated: boolean;
  readonly ranges: readonly (readonly [number, number])[];
}

export const POSIX_CLASSES: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  alpha: [
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  digit: [[0x30, 0x39]],
  alnum: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  upper: [[0x41, 0x5a]],
  lower: [[0x61, 0x7a]],
  space: [
    [0x09, 0x0d],
    [0x20, 0x20],
  ],
  blank: [
    [0x09, 0x09],
    [0x20, 0x20],
  ],
  punct: [
    [0x21, 0x2f],
    [0x3a, 0x40],
    [0x5b, 0x60],
    [0x7b, 0x7e],
  ],
  print: [[0x20, 0x7e]],
  graph: [[0x21, 0x7e]],
  cntrl: [
    [0x00, 0x1f],
    [0x7f, 0x7f],
  ],
  xdigit: [
    [0x30, 0x39],
    [0x41, 0x46],
    [0x61, 0x66],
  ],
};

const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const CASE_GAP = 0x20;

export function foldPosixRanges(
  ranges: readonly (readonly [number, number])[],
): (readonly [number, number])[] {
  const folded: (readonly [number, number])[] = [...ranges];
  for (const [low, high] of ranges) {
    const upperLow = Math.max(low, UPPER_A);
    const upperHigh = Math.min(high, UPPER_Z);
    if (upperLow <= upperHigh) folded.push([upperLow + CASE_GAP, upperHigh + CASE_GAP]);
    const lowerLow = Math.max(low, LOWER_A);
    const lowerHigh = Math.min(high, LOWER_Z);
    if (lowerLow <= lowerHigh) folded.push([lowerLow - CASE_GAP, lowerHigh - CASE_GAP]);
  }
  return folded;
}

export function inPosixSet(set: PosixCharSet, point: number): boolean {
  let present = false;
  for (const [low, high] of set.ranges) {
    if (point >= low && point <= high) {
      present = true;
      break;
    }
  }
  return set.negated ? !present : present;
}
