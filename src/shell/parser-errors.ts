import { VfsError } from "../core/errors.js";

class IncompleteShellSyntaxError extends VfsError {
  constructor(message: string) {
    super("EINVAL", message);
    this.name = "IncompleteShellSyntaxError";
  }
}

export function incompleteShellSyntaxError(message: string): VfsError {
  return new IncompleteShellSyntaxError(message);
}

export function isIncompleteShellSyntaxError(error: unknown): boolean {
  return error instanceof IncompleteShellSyntaxError;
}
