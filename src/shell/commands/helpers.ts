import { VfsError } from "../../core/errors.js";
import { splitLinesPreservingEndings } from "../../core/lines.js";
import { basename, normalizePath } from "../../core/path.js";
import { encodeUtf8, utf8ByteLength } from "../../core/unicode.js";
import type { ByteRange, EntryPage, InlineReadResult } from "../../vfs/types.js";
import { openContent } from "../content.js";
import type { ShellCommandContext, ShellSink } from "../types.js";

export interface BufferLease<T> {
  value: T;
  release(): void;
}

export function commandPath(context: ShellCommandContext, path = "."): string {
  return normalizePath(path, context.session.cwd);
}

export async function writeBytes(sink: ShellSink, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 0) await sink.write(bytes);
}

export async function writeText(sink: ShellSink, value: string): Promise<void> {
  await writeBytes(sink, encodeUtf8(value));
}

export async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const cancellation = (): VfsError =>
    signal.reason instanceof VfsError
      ? signal.reason
      : new VfsError("ECANCELED", "execution was cancelled");
  if (signal.aborted) throw cancellation();
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = (): void => {
      const error = cancellation();
      void reader.cancel(error).catch(() => undefined);
      reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
}

export class BufferedTextWriter {
  private readonly context: ShellCommandContext;
  private readonly sink: ShellSink;
  private readonly slabBytes: number;
  private buffer = "";
  private bytes = 0;
  private release: () => void = () => undefined;

  constructor(context: ShellCommandContext, sink: ShellSink, slabBytes = 64 * 1024) {
    this.context = context;
    this.sink = sink;
    this.slabBytes = slabBytes;
  }

  async write(value: string): Promise<void> {
    const bytes = utf8ByteLength(value);
    if (this.bytes > 0 && this.bytes + bytes > this.slabBytes) await this.flush();
    if (bytes >= this.slabBytes) {
      await writeText(this.sink, value);
      return;
    }
    this.release();
    this.buffer += value;
    this.bytes += bytes;
    this.release = this.context.budget.buffered(this.bytes);
  }

  async flush(): Promise<void> {
    if (this.bytes === 0) return;
    const value = this.buffer;
    this.buffer = "";
    this.bytes = 0;
    this.release();
    this.release = () => undefined;
    await writeText(this.sink, value);
  }

  abort(): void {
    this.buffer = "";
    this.bytes = 0;
    this.release();
    this.release = () => undefined;
  }
}

export async function* inputStreams(
  context: ShellCommandContext,
  argv: readonly string[],
  stdin: ReadableStream<Uint8Array>,
  range?: ByteRange,
): AsyncGenerator<{ name: string; stream: ReadableStream<Uint8Array> }> {
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
async function openInput(
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

/**
 * Walks the file operands of a recursive command.
 *
 * A directory expands through `findPage`, so a large subtree costs a bounded
 * number of indexed queries and never materializes the whole namespace. Each
 * page charges the shared glob budget, which is what bounds the walk, and a
 * non-directory operand is yielded as itself so `grep -r file` still works.
 */
/**
 * One entry of a recursive walk: an openable stream, or the reason it is not.
 *
 * Only the walk produces the failing member. A named operand that cannot be
 * opened is the caller's own error and still throws; an unreadable file found
 * partway through a subtree is not, and stopping the walk there would throw
 * away every match already reported.
 */
export type CommandInput =
  | {
      readonly name: string;
      readonly stream: ReadableStream<Uint8Array>;
      readonly error?: undefined;
    }
  | { readonly name: string; readonly stream?: undefined; readonly error: VfsError };

async function* recursiveDirectoryInputs(
  context: ShellCommandContext,
  operand: string,
  root: string,
): AsyncGenerator<CommandInput> {
  let cursor: string | null = null;
  do {
    context.budget.step();
    const page: EntryPage = context.fileSystem.findPage({
      path: root,
      type: "file",
      ...(cursor === null ? {} : { cursor }),
    });
    context.budget.glob(page.scanned);
    for (const entry of page.entries) {
      const name = displayPath(operand, root, entry.path);
      try {
        yield { name, stream: await openInput(context, entry.path) };
      } catch (error) {
        yield {
          name,
          error: error instanceof VfsError ? error : new VfsError("EIO", "read failed", entry.path),
        };
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
}

export async function* recursiveInputs(
  context: ShellCommandContext,
  paths: readonly string[],
): AsyncGenerator<CommandInput> {
  // With no operand the walk starts at the working directory but reports bare
  // relative paths, as `grep -r` does — an explicit `.` is what prints `./`.
  for (const path of paths.length === 0 ? [""] : paths) {
    const normalized = commandPath(context, path === "" ? "." : path);
    const stat = context.fileSystem.stat(normalized);
    if (stat.kind !== "directory") {
      yield { name: path, stream: await openInput(context, normalized) };
      continue;
    }
    const root = context.fileSystem.realpath(normalized);
    yield* recursiveDirectoryInputs(context, path, root);
  }
}

/**
 * Renders a resolved path the way the operand was written.
 *
 * A recursive utility reports `t/sub/b.txt` for the operand `t`, not the
 * absolute path it resolved to, because that is what the caller named and what
 * every other tool prints.
 */
/**
 * Where an operand that may name a directory actually writes.
 *
 * `mv a b`, `cp a b`, and `ln -s a b` all mean "inside b" when b is an
 * existing directory, and "at b" otherwise. Deciding that once keeps the three
 * from drifting apart.
 */
export function destinationPath(
  context: ShellCommandContext,
  source: string,
  targetValue: string,
): string {
  const target = commandPath(context, targetValue);
  const stat = context.fileSystem.inspectWriteTarget(target);
  if (stat === null) return target;
  return stat.kind === "directory" ? `${target === "/" ? "" : target}/${basename(source)}` : target;
}

export function displayPath(operand: string, resolved: string, entry: string): string {
  if (entry === resolved) return operand;
  const suffix = resolved === "/" ? entry : entry.slice(resolved.length);
  if (operand === "") return suffix.replace(/^\//u, "");
  return `${operand.replace(/\/$/u, "")}${suffix}`;
}

function decodeUtf8(decoder: TextDecoder, chunk: Uint8Array | undefined, path?: string): string {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
  } catch {
    throw new VfsError("EIO", "input is not valid UTF-8", path);
  }
}

interface TextLineState {
  pending: string;
  records: number;
}

function accountRecord(state: TextLineState, context: ShellCommandContext, path?: string): void {
  context.budget.step();
  state.records += 1;
  if (state.records > context.budget.limits.maxBufferedRecords) {
    throw new VfsError("E2BIG", "input record limit exceeded", path);
  }
}

function takeTextLine(
  state: TextLineState,
  context: ShellCommandContext,
  path?: string,
): string | undefined {
  const newline = state.pending.indexOf("\n");
  if (newline < 0) return undefined;
  const line = state.pending.slice(0, newline + 1);
  state.pending = state.pending.slice(newline + 1);
  if (utf8ByteLength(line) > context.budget.limits.maxLineBytes) {
    throw new VfsError("E2BIG", "line byte limit exceeded", path);
  }
  accountRecord(state, context, path);
  return line;
}

export async function* readTextLines(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  path?: string,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: TextLineState = { pending: "", records: 0 };
  let finished = false;
  try {
    for (;;) {
      const read = await readWithAbort(reader, context.signal);
      if (read.done) {
        state.pending += decodeUtf8(decoder, undefined, path);
        finished = true;
        break;
      }
      context.budget.io(read.value.byteLength);
      state.pending += decodeUtf8(decoder, read.value, path);
      for (;;) {
        const line = takeTextLine(state, context, path);
        if (line === undefined) break;
        yield line;
      }
      if (utf8ByteLength(state.pending) > context.budget.limits.maxLineBytes) {
        throw new VfsError("E2BIG", "line byte limit exceeded", path);
      }
    }
    if (state.pending.length > 0) {
      accountRecord(state, context, path);
      yield state.pending;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (!finished)
      await reader
        .cancel(new VfsError("EPIPE", "line consumer stopped early"))
        .catch(() => undefined);
    reader.releaseLock();
  }
}

export async function collectStream(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  maximumBytes = context.budget.limits.maxBufferedBytes,
): Promise<BufferLease<Uint8Array>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let release: () => void = () => undefined;
  let retained = false;
  try {
    for (;;) {
      const result = await readWithAbort(reader, context.signal);
      if (result.done) break;
      total += result.value.byteLength;
      context.budget.io(result.value.byteLength);
      if (total > maximumBytes)
        throw new VfsError("E2BIG", "buffered command input limit exceeded");
      release();
      release = context.budget.buffered(total);
      chunks.push(result.value.slice());
    }
    const releaseOutput = context.budget.buffered(total);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    release();
    release = releaseOutput;
    retained = true;
    return { value: bytes, release: releaseOutput };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    if (!retained) release();
  }
}

export async function collectText(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  path?: string,
  maximumBytes = context.budget.limits.maxBufferedBytes,
): Promise<BufferLease<string>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let total = 0;
  let release: () => void = () => undefined;
  let retained = false;
  try {
    while (true) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
      }
      const result = await readWithAbort(reader, context.signal);
      if (result.done) break;
      total += result.value.byteLength;
      context.budget.io(result.value.byteLength);
      if (total > maximumBytes) {
        throw new VfsError("E2BIG", "buffered command input limit exceeded");
      }
      release();
      release = context.budget.buffered(total);
      const decoded = decodeUtf8(decoder, result.value, path);
      if (decoded.length > 0) chunks.push(decoded);
    }
    const final = decodeUtf8(decoder, undefined, path);
    if (final.length > 0) chunks.push(final);
    retained = true;
    return { value: chunks.join(""), release };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    if (!retained) release();
  }
}

function readFile(context: ShellCommandContext, path: string): InlineReadResult {
  return context.fileSystem.readFile(commandPath(context, path));
}

export async function readFileBytes(
  context: ShellCommandContext,
  path: string,
): Promise<BufferLease<Uint8Array>> {
  const read = readFile(context, path);
  return await collectStream(context, read.stream);
}

export async function readFileText(
  context: ShellCommandContext,
  path: string,
  maximumBytes?: number,
): Promise<BufferLease<string>> {
  const normalized = commandPath(context, path);
  const read = context.fileSystem.readFile(normalized);
  try {
    return await collectText(context, read.stream, normalized, maximumBytes);
  } catch (error) {
    if (error instanceof VfsError && error.path === undefined) {
      throw new VfsError(error.code, error.message, normalized);
    }
    throw error;
  }
}

export async function pipeToSink(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  sink: ShellSink,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
      }
      const result = await readWithAbort(reader, context.signal);
      if (result.done) break;
      context.budget.io(result.value.byteLength);
      await sink.write(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function parseInteger(value: string, name: string, minimum = 0): number {
  if (!/^-?[0-9]+$/u.test(value)) throw new VfsError("EINVAL", `${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new VfsError("EINVAL", `${name} must be at least ${minimum}`);
  }
  return parsed;
}

export function splitLines(value: string): string[] {
  return splitLinesPreservingEndings(value);
}

export async function inputTexts(
  context: ShellCommandContext,
  argv: readonly string[],
  stdin: ReadableStream<Uint8Array>,
): Promise<BufferLease<Array<{ name: string; text: string }>>> {
  if (argv.length === 0) {
    const collected = await collectText(context, stdin);
    return { value: [{ name: "-", text: collected.value }], release: collected.release };
  }
  const output: Array<{ name: string; text: string }> = [];
  const releases: Array<() => void> = [];
  try {
    for (const path of argv) {
      const collected =
        path === "-" ? await collectText(context, stdin) : await readFileText(context, path);
      output.push({ name: path, text: collected.value });
      releases.push(collected.release);
    }
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  return {
    value: output,
    release: () => {
      for (const release of releases) release();
    },
  };
}
