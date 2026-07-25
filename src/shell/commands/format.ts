/** `S_IFMT`: the mode bits that say what kind of thing an entry is. */
export const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE_TYPE = 0o100000;
export const CHARACTER_DEVICE_TYPE = 0o020000;

/**
 * Whether an entry is a regular file rather than a device wearing the same
 * kind.
 *
 * The namespace kind says `file` for both, so the mode's type field is the only
 * thing that separates them — and there are two implementations of `test -f`
 * to keep in step, which is reason enough for one definition.
 */
export function isRegularFile(stat: { readonly mode: number }): boolean {
  return (stat.mode & FILE_TYPE_MASK) === REGULAR_FILE_TYPE;
}

/** Whether an entry is one of the virtual character devices. */
export function isCharacterDevice(stat: { readonly mode: number }): boolean {
  return (stat.mode & FILE_TYPE_MASK) === CHARACTER_DEVICE_TYPE;
}

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
