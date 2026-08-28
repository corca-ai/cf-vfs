/** Every error code this package raises. */
export const VFS_ERROR_CODES = [
  "EACCES",
  "EAGAIN",
  "E2BIG",
  "EEXIST",
  "EFBIG",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ENAMETOOLONG",
  "ENOTDIR",
  "ELOOP",
  "ENOTEMPTY",
  "ENOENT",
  "ENOEXEC",
  "ENOSPC",
  "ENOSYS",
  "ENOTSUP",
  "EPIPE",
  "EPERM",
  "ETIMEDOUT",
  "ECANCELED",
  "EREVISION",
] as const;

export type VfsErrorCode = (typeof VFS_ERROR_CODES)[number];

const RECOGNIZED_CODES: ReadonlySet<string> = new Set(VFS_ERROR_CODES);

export class VfsError extends Error {
  readonly code: VfsErrorCode;
  readonly path: string | undefined;

  constructor(code: VfsErrorCode, message: string, path?: string) {
    super(message);
    this.name = "VfsError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Recognizes a `VfsError`, including one that crossed a Workers RPC boundary.
 *
 * RPC rebuilds a thrown error as a plain `Error` that keeps the original own
 * properties but not the prototype, so `instanceof` alone reports `false` for
 * every failure a caller observes through a `VfsDurableObject` or
 * `ShellDurableObject` stub. Matching the tagged `name` and a recognized `code`
 * keeps `error.code` usable on both sides of that boundary.
 */
export function isVfsError(error: unknown): error is VfsError {
  if (error instanceof VfsError) return true;
  if (!(error instanceof Error)) return false;
  try {
    if (error.name !== "VfsError") return false;
    const code: unknown = Reflect.get(error, "code");
    return typeof code === "string" && RECOGNIZED_CODES.has(code);
  } catch {
    // Predicates at an unknown boundary must not replace the original failure
    // merely because a foreign Error exposes an accessor that throws.
    return false;
  }
}
