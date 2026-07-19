export type VfsErrorCode =
  | "E2BIG"
  | "EEXIST"
  | "EINVAL"
  | "EIO"
  | "EISDIR"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "ENOTTEXT"
  | "ENOENT"
  | "ENOSYS"
  | "EREVISION";

export class VfsError extends Error {
  readonly code: VfsErrorCode;
  readonly path?: string;

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
