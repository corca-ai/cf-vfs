export type VfsErrorCode =
  | "E2BIG"
  | "EEXIST"
  | "EFBIG"
  | "EINVAL"
  | "EIO"
  | "EISDIR"
  | "ENAMETOOLONG"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "ENOTTEXT"
  | "ENOENT"
  | "ENOSYS"
  | "ENOTSUP"
  | "EREVISION";

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

export function isVfsError(error: unknown): error is VfsError {
  return error instanceof VfsError;
}
