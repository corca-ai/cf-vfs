import { VfsError } from "../../core/errors.js";
import type { InlineFileBody } from "../../vfs/types.js";
import type { ShellBudget, ShellCommandContext } from "../types.js";

const READ_AHEAD_BYTES = 1024 * 1024;

/** Bytes every read-ahead of one execution holds together, whatever its stages. */
const POOLS = new WeakMap<ShellBudget, { held: number }>();

function poolFor(budget: ShellBudget): { held: number } {
  let pool = POOLS.get(budget);
  if (pool === undefined) {
    pool = { held: 0 };
    POOLS.set(budget, pool);
  }
  return pool;
}

/**
 * Bodies read ahead in bulk for a command that reads many files in a row.
 *
 * On Workers a call and a stream per file cost more than reading the body,
 * so the next files are read in one `readMany` call. A body is handed out
 * only while the filesystem reports no change since it was read, so a
 * command gets exactly what reading the file at that moment would give; any
 * change discards everything read ahead, and the caller reads the rest one
 * file at a time.
 *
 * What is held is bounded by its own pool rather than charged to the shell's
 * buffer, so a command meets every buffer limit where it would reading one
 * file at a time: every read-ahead of one execution — concurrent pipeline
 * stages included — holds at most 1 MiB together, and a fill takes at most a
 * quarter of the shell's free buffer.
 *
 * A body is a snapshot that is still current when it is handed over, so what
 * a command reads is what reading the file at that moment would give. Reading
 * this way awaits less often than a stream does, so a stage running beside it
 * may interleave differently; either order is one a reader could see.
 */
export class ReadAhead {
  readonly #context: ShellCommandContext;
  readonly #bodies = new Map<string, InlineFileBody>();
  readonly #pool: { held: number };
  #generation = Number.NaN;

  constructor(context: ShellCommandContext) {
    this.#context = context;
    this.#pool = poolFor(context.budget);
  }

  /** What one fill may hold; zero when bulk reads are unavailable. */
  allowance(): number {
    const { budget, fileSystem } = this.#context;
    if (fileSystem.readMany === undefined || fileSystem.changeGeneration === undefined) return 0;
    return Math.max(
      0,
      Math.min(
        READ_AHEAD_BYTES - this.#pool.held,
        Math.floor((budget.remainingBufferedBytes?.() ?? 0) / 4),
      ),
    );
  }

  /** Replaces what is held with the bodies of `paths` that can be read in bulk. */
  fill(paths: readonly string[]): void {
    this.release();
    const allowance = this.allowance();
    const { fileSystem } = this.#context;
    if (allowance <= 0 || paths.length < 2 || fileSystem.readMany === undefined) return;
    const bodies = fileSystem.readMany(paths, { maxBytes: allowance });
    // In the same synchronous turn as the read, so no write can fall between.
    this.#generation = this.#current();
    paths.forEach((path, index) => {
      const read = bodies[index];
      if (read === undefined || this.#bodies.has(path)) return;
      this.#bodies.set(path, read);
      this.#pool.held += read.stat.sizeBytes;
    });
  }

  /**
   * The body read ahead for `path` if it is still current, handed over once.
   *
   * While nothing has changed since the fill every held body is current.
   * Once something has, a body is still handed over when one fresh stat of
   * its path — which also checks that the path can still be reached — shows
   * the same entry at the same revision and mutation token: every write of a
   * body or its metadata moves both, so the bytes are what a read would
   * return now. A file with other hard links is read again instead.
   */
  take(path: string): InlineFileBody | undefined {
    const read = this.#bodies.get(path);
    if (read === undefined) return undefined;
    this.#drop(path, read);
    if (this.#current() === this.#generation) return read;
    return this.#revalidated(path, read);
  }

  #revalidated(path: string, read: InlineFileBody): InlineFileBody | undefined {
    const { fileSystem } = this.#context;
    if ((read.stat.nlink ?? 1) > 1 || fileSystem.statMany === undefined) return undefined;
    let result: ReturnType<NonNullable<typeof fileSystem.statMany>>[number] | undefined;
    try {
      [result] = fileSystem.statMany([path]);
    } catch (error) {
      // A refusal here is reported by the ordinary read, in its own place.
      if (error instanceof VfsError) return undefined;
      throw error;
    }
    if (result === undefined || !("stat" in result)) return undefined;
    const now = result.stat;
    const same =
      now.kind === "file" &&
      now.contentClass === "inline" &&
      now.path === read.stat.path &&
      now.ino === read.stat.ino &&
      now.revision === read.stat.revision &&
      now.mutationToken === read.stat.mutationToken &&
      now.sizeBytes === read.stat.sizeBytes;
    return same ? { stat: now, chunks: read.chunks } : undefined;
  }

  /** Drops what is held. */
  release(): void {
    for (const [path, read] of this.#bodies) this.#drop(path, read);
  }

  #drop(path: string, read: InlineFileBody): void {
    this.#bodies.delete(path);
    this.#pool.held -= read.stat.sizeBytes;
  }

  #current(): number {
    return this.#context.fileSystem.changeGeneration?.() ?? Number.NaN;
  }
}
