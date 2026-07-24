export function modeString(mode: number): string {
  const kind = (mode & 0o040000) !== 0 ? "d" : "-";
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const labels = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return kind + bits.map((bit, index) => (mode & bit) !== 0 ? labels[index] : "-").join("");
}
