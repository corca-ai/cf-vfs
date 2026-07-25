/** `S_IFMT`: the mode bits that say what kind of thing an entry is. */
export const FILE_TYPE_MASK = 0o170000;
export const REGULAR_FILE_TYPE = 0o100000;
export const CHARACTER_DEVICE_TYPE = 0o020000;

export function modeString(mode: number): string {
  // The type is a field, not a flag: masking one bit reads `S_IFLNK` as a
  // regular file, because the two share no bit in common.
  const type = mode & FILE_TYPE_MASK;
  const kind =
    type === 0o040000 ? "d" : type === 0o120000 ? "l" : type === CHARACTER_DEVICE_TYPE ? "c" : "-";
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const labels = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return kind + bits.map((bit, index) => ((mode & bit) !== 0 ? labels[index] : "-")).join("");
}
