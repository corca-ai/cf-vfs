import { VfsError } from "./errors.js";

/** Raised for a filter this profile does not accept. Status 3, as in `jq`. */
export class JqSyntaxError extends VfsError {
  constructor(message: string) {
    super("EINVAL", message);
  }
}

/** Raised while running a filter. Status 5, as in `jq`. */
export class JqRuntimeError extends VfsError {
  constructor(message: string) {
    super("EINVAL", message);
  }
}
