import { VfsError } from "../core/errors.js";

export class ShellNounsetError extends VfsError {
  constructor(name: string, message = `${name}: unbound variable`) {
    super("EINVAL", message);
    this.name = "ShellNounsetError";
  }
}
