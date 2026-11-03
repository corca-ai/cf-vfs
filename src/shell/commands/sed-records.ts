/**
 * sed's input and stepping: records from each input in turn, with the
 * lookahead `$` needs, and the driver that runs the sed machine's generator,
 * awaiting only what it yields. Kept apart from sed.ts, which holds the
 * machine itself.
 */
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { type TextLines, textLines } from "./helpers.js";
import { inputSources } from "./inputs.js";

export interface SedRecord {
  readonly value: string;
  readonly terminated: boolean;
}

/** Input records with one record of lookahead, which `$` needs. */
export interface RecordSource {
  /** The next record, at once when it is at hand. */
  next(): SedRecord | undefined | Promise<SedRecord | undefined>;
  isLast(): boolean | Promise<boolean>;
  /** Stops reading, so `q` cancels its input rather than draining it. */
  close(): Promise<void>;
}

/**
 * Records from each input's lines in turn. A body read in bulk yields its
 * records synchronously, and a stream a chunk's worth at a time; only the
 * next chunk, or moving on to the next input, has to be awaited.
 */
export class LineSource implements RecordSource {
  /** The lines at hand: a bulk body's, or the current chunk's of a stream. */
  #lines: Iterator<string> | undefined;
  /** A stream input's chunks, while it has more. */
  #runs: AsyncIterator<Iterable<string>> | undefined;
  #peeked: SedRecord | undefined | null = null;

  constructor(private readonly inputs: AsyncIterator<TextLines>) {}

  next(): SedRecord | undefined | Promise<SedRecord | undefined> {
    if (this.#peeked === null) return this.#pull();
    const record = this.#peeked;
    this.#peeked = null;
    return record;
  }

  isLast(): boolean | Promise<boolean> {
    if (this.#peeked !== null) return this.#peeked === undefined;
    const pulled = this.#pull();
    if (pulled instanceof Promise) {
      return pulled.then((record) => {
        this.#peeked = record;
        return record === undefined;
      });
    }
    this.#peeked = pulled;
    return pulled === undefined;
  }

  #pull(): SedRecord | undefined | Promise<SedRecord | undefined> {
    if (this.#lines !== undefined) {
      const step = this.#lines.next();
      if (!step.done) return toRecord(step.value);
      this.#lines = undefined;
    }
    return this.#pullAsync();
  }

  async #pullAsync(): Promise<SedRecord | undefined> {
    for (;;) {
      if (this.#lines !== undefined) {
        const step = this.#lines.next();
        if (!step.done) return toRecord(step.value);
        this.#lines = undefined;
      }
      if (this.#runs !== undefined) {
        const run = await this.#runs.next();
        if (run.done) this.#runs = undefined;
        else this.#lines = run.value[Symbol.iterator]();
        continue;
      }
      const input = await this.inputs.next();
      if (input.done) return undefined;
      if (Symbol.asyncIterator in input.value) {
        this.#runs = input.value[Symbol.asyncIterator]();
      } else this.#lines = input.value[Symbol.iterator]();
    }
  }

  async close(): Promise<void> {
    const lines = this.#lines;
    const runs = this.#runs;
    this.#lines = undefined;
    this.#runs = undefined;
    try {
      try {
        lines?.return?.(undefined);
      } finally {
        await runs?.return?.(undefined);
      }
    } finally {
      // The inputs are released even when closing the current one fails.
      await this.inputs.return?.(undefined);
    }
  }
}

function toRecord(line: string): SedRecord {
  const terminated = line.endsWith("\n");
  return { value: terminated ? line.slice(0, -1) : line, terminated };
}

export async function* inputLines(
  context: ShellCommandContext,
  operands: readonly string[],
  stdin: ShellFileDescriptors[0],
): AsyncGenerator<TextLines> {
  // Numbering and `$` span the operands as one stream, the way `sed` reads
  // them: `$` is the last record of the last file, not of each file.
  for await (const input of inputSources(context, operands, stdin)) {
    yield textLines(context, input.source, input.name);
  }
}

/** The lines of a whole text, each with the newline that ended it. */
export function* splitLines(text: string): Generator<string> {
  let at = 0;
  while (at < text.length) {
    const newline = text.indexOf("\n", at);
    const end = newline < 0 ? text.length : newline + 1;
    yield text.slice(at, end);
    at = end;
  }
}

export async function* oneInput(lines: TextLines): AsyncGenerator<TextLines> {
  yield lines;
}

/** What the runner waits on before it can go on. */
export type Steps<T> = Generator<Promise<unknown>, T, unknown>;

/**
 * Runs `steps`, awaiting only what they yield: at once when they never wait.
 * It can therefore throw synchronously as well as reject; call it where both
 * reach the same handler, as inside an `async` function's `try`.
 */
export function drive<T>(steps: Steps<T>): T | Promise<T> {
  const step = steps.next();
  return step.done ? step.value : resume(steps, step.value);
}

async function resume<T>(steps: Steps<T>, first: Promise<unknown>): Promise<T> {
  let waiting = first;
  for (;;) {
    let value: unknown;
    let failure: { error: unknown } | undefined;
    try {
      value = await waiting;
    } catch (error) {
      failure = { error };
    }
    const step = failure === undefined ? steps.next(value) : steps.throw(failure.error);
    if (step.done) return step.value;
    waiting = step.value;
  }
}
