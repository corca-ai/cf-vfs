import { VfsError } from "../../core/errors.js";
import { streamFromOwnedChunks } from "../../vfs/streams.js";
import type { ByteRange } from "../../vfs/types.js";
import { fileBody, openContent } from "../content.js";
import type { ShellCommandContext } from "../types.js";
import { commandPath } from "./helpers.js";
import { ReadAhead } from "./read-ahead.js";

/**
 * A command's input: a stream, or a file body read in bulk as the chunks its
 * stream would have yielded, which a consumer can take without a stream.
 */
export type InputSource = ReadableStream<Uint8Array> | readonly Uint8Array<ArrayBuffer>[];

/** How many operands one read-ahead covers. */
const OPERAND_WINDOW = 64;

/**
 * Opens one operand, streaming an opaque R2 body when the session allows it.
 *
 * Every path into a command's input goes through here — operands, recursive
 * walks, and `<` redirection — so a command cannot accidentally get a
 * different answer depending on how its input was spelled.
 *
 * A consumer that stops early cancels the stream, which stops the transfer.
 * The retention lease behind an opaque read is a deadline in the row and
 * lapses on its own; there is nothing to release.
 */
export async function openInput(
  context: ShellCommandContext,
  path: string,
  range?: ByteRange,
): Promise<ReadableStream<Uint8Array>> {
  const body = await openContent(context.fileSystem, commandPath(context, path), {
    reader: context.content,
    access: context.policy.opaqueContent,
    signal: context.signal,
    ...(range === undefined ? {} : { range }),
  });
  return body.stream;
}

/** A stream over a source, so a stream consumer reads a bulk body as it would a file. */
export function sourceStream(source: InputSource): ReadableStream<Uint8Array> {
  return Array.isArray(source)
    ? fileBody(streamFromOwnedChunks(source as Uint8Array<ArrayBuffer>[]))
    : (source as ReadableStream<Uint8Array>);
}

/**
 * Reads a command's file operands ahead in windows, so each is taken in bulk
 * where it can be. See {@link ReadAhead}: what an operand yields is what
 * opening it at its turn would, and anything else is opened at its turn.
 */
export class OperandReader {
  readonly #context: ShellCommandContext;
  readonly #argv: readonly string[];
  readonly #ahead: ReadAhead;
  #window = 0;

  constructor(context: ShellCommandContext, argv: readonly string[]) {
    this.#context = context;
    this.#argv = argv;
    this.#ahead = new ReadAhead(context);
  }

  /** The bulk body of operand `index`, or undefined to open it. */
  take(index: number): readonly Uint8Array<ArrayBuffer>[] | undefined {
    if (index >= this.#window) {
      this.#window = index + OPERAND_WINDOW;
      this.#ahead.fill(this.#paths(this.#argv.slice(index, this.#window)));
    }
    const path = this.#argv[index];
    if (path === undefined || path === "-") return undefined;
    return this.#ahead.take(this.#resolved(path) ?? "")?.chunks;
  }

  release(): void {
    this.#ahead.release();
  }

  #paths(operands: readonly string[]): string[] {
    return operands.flatMap((path) => {
      const resolved = path === "-" ? undefined : this.#resolved(path);
      return resolved === undefined ? [] : [resolved];
    });
  }

  #resolved(path: string): string | undefined {
    try {
      return commandPath(this.#context, path);
    } catch (error) {
      if (error instanceof VfsError) return undefined;
      throw error;
    }
  }
}

/** Each operand in turn, `-` and no operands meaning standard input. */
export async function* inputSources(
  context: ShellCommandContext,
  argv: readonly string[],
  stdin: ReadableStream<Uint8Array>,
): AsyncGenerator<{ name: string; source: InputSource }> {
  if (argv.length === 0) {
    yield { name: "-", source: stdin };
    return;
  }
  const operands = new OperandReader(context, argv);
  try {
    for (const [index, path] of argv.entries()) {
      if (path === "-") {
        yield { name: "-", source: stdin };
        continue;
      }
      yield { name: path, source: operands.take(index) ?? (await openInput(context, path)) };
    }
  } finally {
    operands.release();
  }
}

export async function* inputStreams(
  context: ShellCommandContext,
  argv: readonly string[],
  stdin: ReadableStream<Uint8Array>,
  range?: ByteRange,
): AsyncGenerator<{ name: string; stream: ReadableStream<Uint8Array> }> {
  if (range === undefined) {
    for await (const { name, source } of inputSources(context, argv, stdin)) {
      yield { name, stream: sourceStream(source) };
    }
    return;
  }
  if (argv.length === 0) {
    yield { name: "-", stream: stdin };
    return;
  }
  for (const path of argv) {
    if (path === "-") {
      yield { name: "-", stream: stdin };
      continue;
    }
    yield { name: path, stream: await openInput(context, path, range) };
  }
}
