import type { PosixCredentials, VfsStat } from "../vfs/types.js";

export type PosixPermission = 1 | 2 | 4;

/**
 * Answers a mode predicate for the immutable credentials of one execution.
 *
 * Without credentials this preserves the compatibility profile: any class
 * carrying the requested bit is reported. With credentials exactly one of
 * owner, group, or other applies. Root bypasses read/write checks, but a file
 * still needs at least one execute bit to be executable.
 */
export function shellModeAllows(
  stat: VfsStat,
  credentials: PosixCredentials | undefined,
  permission: PosixPermission,
): boolean {
  if (credentials === undefined) {
    return (stat.mode & (permission * 0o111)) !== 0;
  }
  if (credentials.uid === 0) {
    return permission !== 1 || stat.kind === "directory" || (stat.mode & 0o111) !== 0;
  }
  const bits =
    stat.uid === credentials.uid
      ? (stat.mode >> 6) & 0o7
      : stat.gid === credentials.gid || (credentials.supplementaryGids ?? []).includes(stat.gid)
        ? (stat.mode >> 3) & 0o7
        : stat.mode & 0o7;
  return (bits & permission) !== 0;
}
