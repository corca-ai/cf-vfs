/**
 * Splitting a command's input into lines — bulk-read bodies synchronously,
 * streams a chunk at a time — with the read, line and record limits charged
 * where reading the input line by line would charge them.
 */

import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import { chargeConsumed } from "../content.js";
import type { ShellCommandContext } from "../types.js";
import { cancellation, watchReader } from "./watch-reader.js";

/**
 * Whether `text` is more than `maxBytes` of UTF-8. No UTF-16 unit takes more
 * than three bytes, so text short enough is answered without measuring it.
 */
function exceedsLine(text: string, maxBytes: number): boolean {
  return text.length * 3 > maxBytes && utf8ByteLength(text) > maxBytes;
}

export function decodeUtf8(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  path?: string,
): string {
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

/**
 * Counts one decoded record. It charges no step: reading is bounded by the
 * I/O byte limit, and steps are kept for work input size does not bound.
 */
function accountRecord(state: TextLineState, context: ShellCommandContext, path?: string): void {
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
  if (exceedsLine(line, context.budget.limits.maxLineBytes)) {
    throw new VfsError("E2BIG", "line byte limit exceeded", path);
  }
  accountRecord(state, context, path);
  return line;
}

/**
 * Splits bulk-read chunks into lines exactly as {@link readTextLines} splits
 * the stream that would have yielded them, charging each chunk as a file read.
 *
 * `decoded`, for a one-chunk body, is its text already decoded with a fatal
 * UTF-8 decoder that strips a leading BOM, as decoding the chunk here would
 * give it, so it is not decoded twice; it is ignored for longer bodies.
 */
function* chunkTextLines(
  context: ShellCommandContext,
  chunks: readonly Uint8Array[],
  path?: string,
  decoded?: string,
): Generator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: TextLineState = { pending: "", records: 0 };
  const whole = chunks.length === 1 ? decoded : undefined;
  for (const chunk of chunks) {
    if (context.signal.aborted) throw cancellation(context.signal);
    context.budget.read(chunk.byteLength);
    state.pending += whole ?? decodeUtf8(decoder, chunk, path);
    for (;;) {
      const line = takeTextLine(state, context, path);
      if (line === undefined) break;
      yield line;
    }
    if (exceedsLine(state.pending, context.budget.limits.maxLineBytes)) {
      throw new VfsError("E2BIG", "line byte limit exceeded", path);
    }
  }
  state.pending += decodeUtf8(decoder, undefined, path);
  if (state.pending.length > 0) {
    accountRecord(state, context, path);
    yield state.pending;
  }
}

/**
 * Consumes bulk-read chunks whose lines a caller will not use, with the charges
 * and failures splitting them would have had. A valid UTF-8 body no larger than
 * the line and record limits can exceed neither, so only its reads are charged.
 */
export function skipTextLines(
  context: ShellCommandContext,
  chunks: readonly Uint8Array[],
  validText: boolean,
  path?: string,
): void {
  const { limits } = context.budget;
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (!validText || bytes > Math.min(limits.maxLineBytes, limits.maxBufferedRecords)) {
    const lines = chunkTextLines(context, chunks, path);
    while (lines.next().done !== true);
    return;
  }
  for (const chunk of chunks) {
    if (context.signal.aborted) throw cancellation(context.signal);
    context.budget.read(chunk.byteLength);
  }
}

/**
 * The lines of a command's input: synchronously for a bulk-read body, a run
 * per chunk for a stream, so a caller iterating them with {@link eachLine}
 * awaits only once per chunk and otherwise only what needs it.
 */
export function textLines(
  context: ShellCommandContext,
  source: ReadableStream<Uint8Array> | readonly Uint8Array[],
  path?: string,
  decoded?: string,
): TextLines {
  return Array.isArray(source)
    ? chunkTextLines(context, source as readonly Uint8Array[], path, decoded)
    : streamLineRuns(context, source as ReadableStream<Uint8Array>, path);
}

/** A bulk body's lines, or a stream's as a run per chunk. */
export type TextLines = Iterable<string> | AsyncIterable<Iterable<string>>;

/**
 * Visits each line until `visit` returns true, awaiting only when `visit`
 * returns a promise or the next chunk of a stream must be read: `for await`
 * would await every value even of a synchronous iterable, and on Workers an
 * await costs more than handling a short line.
 */
export async function eachLine(
  lines: TextLines,
  visit: (line: string) => boolean | Promise<boolean>,
): Promise<void> {
  if (Symbol.asyncIterator in lines) {
    for await (const run of lines) if (await visitRun(run, visit)) return;
    return;
  }
  // Inline rather than through `visitRun`, which would add an await per input.
  for (const line of lines) {
    const stop = visit(line);
    if (stop === true || (stop !== false && (await stop))) return;
  }
}

/** Visits a run's lines; whether `visit` asked to stop. */
async function visitRun(
  run: Iterable<string>,
  visit: (line: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  for (const line of run) {
    const stop = visit(line);
    if (stop === true || (stop !== false && (await stop))) return true;
  }
  return false;
}

export async function* readTextLines(
  context: ShellCommandContext,
  source: ReadableStream<Uint8Array> | readonly Uint8Array[],
  path?: string,
): AsyncGenerator<string> {
  if (Array.isArray(source)) {
    yield* chunkTextLines(context, source, path);
    return;
  }
  // Line by line, as callers here iterate it: built on runs, each line would
  // also step a run's generator.
  const stream = source as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const watched = watchReader(reader, context.signal);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: TextLineState = { pending: "", records: 0 };
  let finished = false;
  try {
    for (;;) {
      const read = await watched.read();
      if (read.done) {
        state.pending += decodeUtf8(decoder, undefined, path);
        finished = true;
        break;
      }
      chargeConsumed(context.budget, stream, read.value.byteLength);
      state.pending += decodeUtf8(decoder, read.value, path);
      for (;;) {
        const line = takeTextLine(state, context, path);
        if (line === undefined) break;
        yield line;
      }
      if (exceedsLine(state.pending, context.budget.limits.maxLineBytes)) {
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
    watched.unwatch();
    reader.releaseLock();
  }
}

/**
 * A stream's lines, a run per chunk read: each run hands out that chunk's
 * lines synchronously, taking each — and checking it against the line and
 * record limits — only when it is asked for, where {@link chunkTextLines}
 * takes it for a bulk body. A caller awaits once per chunk rather than once
 * per line. A caller should drain each run before asking for the next; one
 * that does not loses nothing, as lines a run left behind are the next run's
 * first.
 */
async function* streamLineRuns(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  path?: string,
): AsyncGenerator<Iterable<string>> {
  const reader = stream.getReader();
  const watched = watchReader(reader, context.signal);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: TextLineState = { pending: "", records: 0 };
  // A limit a run trips is the stream's failure: it ends the stream, which is
  // cancelled with it rather than as a consumer that stopped early.
  const failure: { error?: unknown } = {};
  let finished = false;
  try {
    for (;;) {
      const read = await watched.read();
      if ("error" in failure) throw failure.error;
      if (read.done) {
        state.pending += decodeUtf8(decoder, undefined, path);
        finished = true;
        break;
      }
      chargeConsumed(context.budget, stream, read.value.byteLength);
      state.pending += decodeUtf8(decoder, read.value, path);
      yield takenLines(state, context, failure, false, path);
      if ("error" in failure) throw failure.error;
    }
    if (state.pending.length > 0) yield takenLines(state, context, failure, true, path);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (!finished)
      await reader
        .cancel(
          "error" in failure ? failure.error : new VfsError("EPIPE", "line consumer stopped early"),
        )
        .catch(() => undefined);
    watched.unwatch();
    reader.releaseLock();
  }
}

/**
 * The complete lines a chunk made available, taken one at a time; then, as a
 * chunk ends, the check that the partial line it leaves is within the line
 * limit — or, for the end of the stream, that partial line as the last record.
 */
function* takenLines(
  state: TextLineState,
  context: ShellCommandContext,
  failure: { error?: unknown },
  last: boolean,
  path?: string,
): Generator<string> {
  try {
    for (;;) {
      const line = takeTextLine(state, context, path);
      if (line === undefined) break;
      yield line;
    }
    if (last) {
      if (state.pending.length === 0) return;
      accountRecord(state, context, path);
      const line = state.pending;
      state.pending = "";
      yield line;
      return;
    }
    if (exceedsLine(state.pending, context.budget.limits.maxLineBytes)) {
      throw new VfsError("E2BIG", "line byte limit exceeded", path);
    }
  } catch (error) {
    failure.error = error;
    throw error;
  }
}
