import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { ShellBudget } from "../types.js";

/** Check substitution and output growth before materializing amplified text. */
export class SedText {
  private value = "";
  private bytes = 0;

  constructor(
    private readonly budget: ShellBudget,
    private readonly maximumCharacters = budget.limits.maxExpansionChars,
  ) {}

  append(value: string): void {
    this.budget.expansionWork(value.length);
    if (this.value.length + value.length > this.maximumCharacters)
      throw new VfsError("E2BIG", "sed: text expansion limit exceeded");
    const bytes = this.bytes + utf8ByteLength(value);
    // Include buffers held by the surrounding command, such as the -i source.
    this.budget.buffered(bytes)();
    this.bytes = bytes;
    this.value += value;
  }

  result(): string {
    return this.value;
  }
}
