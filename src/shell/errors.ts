import { VfsError } from "../core/errors.js";

export class ShellNounsetError extends VfsError {
  constructor(name: string, message = `${name}: unbound variable`) {
    super("EINVAL", message);
    this.name = "ShellNounsetError";
  }
}

/**
 * Marks a shell-level refusal whose conventional command status is 126.
 *
 * Ordinary filesystem DAC failures also use `EACCES`, but a utility such as
 * `cat` reports those as status 1. Keeping the distinction in the error type
 * prevents the global status mapper from conflating the two.
 */
export class ShellRefusalError extends VfsError {
  constructor(message: string, path?: string) {
    super("EACCES", message, path);
    this.name = "ShellRefusalError";
  }
}
