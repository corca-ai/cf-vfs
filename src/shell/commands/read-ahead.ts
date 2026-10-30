import type { InlineFileBody } from "../../vfs/types.js";
import type { ShellCommandContext } from "../types.js";

const READ_AHEAD_BYTES = 1024 * 1024;

/**
 * Bodies read ahead in bulk for a command that reads many files in a row.
 *
 * On Workers a call and a stream per file cost more than reading the body,
 * so the next files are read in one `readMany` call. A body is handed out
 * only while the filesystem reports no change since it was read, so a
 * command gets exactly what reading the file at that moment would give; any
 * change discards everything read ahead, and the caller reads the rest one
 * file at a time. Bodies held count against the shell's buffer.
 */
export class ReadAhead {
  readonly #context: ShellCommandContext;
  readonly #bodies = new Map<string, InlineFileBody>();
  #generation = Number.NaN;
  #release: () => void = () => undefined;

  constructor(context: ShellCommandContext) {
    this.#context = context;
  }

  /** What one fill may hold; zero when bulk reads are unavailable. */
  allowance(): number {
    const { budget, fileSystem } = this.#context;
    if (fileSystem.readMany === undefined || fileSystem.changeGeneration === undefined) return 0;
    return Math.min(READ_AHEAD_BYTES, Math.floor((budget.remainingBufferedBytes?.() ?? 0) / 4));
  }

  /** Replaces what is held with the bodies of `paths` that can be read in bulk. */
  fill(paths: readonly string[]): void {
    this.release();
    const allowance = this.allowance();
    const { budget, fileSystem } = this.#context;
    if (allowance <= 0 || paths.length < 2 || fileSystem.readMany === undefined) return;
    const bodies = fileSystem.readMany(paths, { maxBytes: allowance });
    // In the same synchronous turn as the read, so no write can fall between.
    this.#generation = fileSystem.changeGeneration?.() ?? Number.NaN;
    let held = 0;
    paths.forEach((path, index) => {
      const read = bodies[index];
      if (read === undefined || this.#bodies.has(path)) return;
      this.#bodies.set(path, read);
      held += read.stat.sizeBytes;
    });
    if (this.#bodies.size > 0) this.#release = budget.buffered(held);
  }

  /** The body read ahead for `path` if it is still current, handed over once. */
  take(path: string): InlineFileBody | undefined {
    const read = this.#bodies.get(path);
    if (read === undefined) return undefined;
    if (this.#context.fileSystem.changeGeneration?.() !== this.#generation) {
      this.release();
      return undefined;
    }
    this.#bodies.delete(path);
    if (this.#bodies.size === 0) this.release();
    return read;
  }

  /** Drops what is held and returns its share of the shell's buffer. */
  release(): void {
    this.#bodies.clear();
    this.#release();
    this.#release = () => undefined;
  }
}
