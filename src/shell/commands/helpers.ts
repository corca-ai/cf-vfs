import { VfsError } from "../../core/errors.js";
import { splitLinesPreservingEndings } from "../../core/lines.js";
import { basename, normalizeFileSystemPath } from "../../core/path.js";
import { encodeUtf8, utf8ByteLength } from "../../core/unicode.js";
import type { InlineReadResult } from "../../vfs/types.js";
import { chargeConsumed, fileBody } from "../content.js";
import type { ShellCommandContext, ShellSink } from "../types.js";
import { decodeUtf8 } from "./line-reader.js";
import { watchReader } from "./watch-reader.js";

export {
  eachLine,
  readTextLines,
  skipTextLines,
  type TextLines,
  textLines,
} from "./line-reader.js";
export { cancellation, watchReader } from "./watch-reader.js";

export interface BufferLease<T> {
  value: T;
  release(): void;
}

export function commandPath(context: ShellCommandContext, path = "."): string {
  return normalizeFileSystemPath(path, context.session.cwd);
}

export async function writeBytes(sink: ShellSink, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 0) await sink.write(bytes);
}

export async function writeText(sink: ShellSink, value: string): Promise<void> {
  await writeBytes(sink, encodeUtf8(value));
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
    const writing = this.put(value);
    if (writing !== undefined) await writing;
  }

  /**
   * Writes `value`, returning a promise only when it had to reach the sink:
   * text that fits the slab is only buffered, and a caller writing line by
   * line need not await each line. Await a returned promise before the next
   * write, or the writes reach the sink out of order; a budget limit throws
   * at once rather than rejecting.
   */
  put(value: string): Promise<void> | undefined {
    const bytes = utf8ByteLength(value);
    if ((this.bytes > 0 && this.bytes + bytes > this.slabBytes) || bytes >= this.slabBytes) {
      return this.#putAfterFlush(value, bytes);
    }
    this.#buffer(value, bytes);
    return undefined;
  }

  async #putAfterFlush(value: string, bytes: number): Promise<void> {
    if (this.bytes > 0 && this.bytes + bytes > this.slabBytes) await this.flush();
    if (bytes >= this.slabBytes) {
      await writeText(this.sink, value);
      return;
    }
    this.#buffer(value, bytes);
  }

  #buffer(value: string, bytes: number): void {
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
  follow = true,
): string {
  const target = commandPath(context, targetValue);
  const stat = context.fileSystem.inspectWriteTarget(target, follow);
  if (stat === null) return target;
  return stat.kind === "directory" ? `${target === "/" ? "" : target}/${basename(source)}` : target;
}

export function displayPath(operand: string, resolved: string, entry: string): string {
  if (entry === resolved) return operand;
  const suffix = resolved === "/" ? entry : entry.slice(resolved.length);
  if (operand === "") return suffix.replace(/^\//u, "");
  return `${operand.replace(/\/$/u, "")}${suffix}`;
}

export async function collectStream(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  maximumBytes = context.budget.limits.maxBufferedBytes,
): Promise<BufferLease<Uint8Array>> {
  const reader = stream.getReader();
  const watched = watchReader(reader, context.signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let release: () => void = () => undefined;
  let retained = false;
  try {
    for (;;) {
      const result = await watched.read();
      if (result.done) break;
      total += result.value.byteLength;
      chargeConsumed(context.budget, stream, result.value.byteLength);
      if (total > maximumBytes)
        throw new VfsError("E2BIG", "buffered command input limit exceeded");
      release();
      release = context.budget.buffered(total);
      chunks.push(result.value.slice());
    }
    const only = chunks.length === 1 ? chunks[0] : undefined;
    if (only !== undefined) {
      context.budget.step(0);
      retained = true;
      return { value: only, release };
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
    watched.unwatch();
    reader.releaseLock();
    if (!retained) release();
  }
}

/** Collects bulk-read chunks as text with the checks {@link collectText} applies to a stream. */
function collectChunkText(
  context: ShellCommandContext,
  chunks: readonly Uint8Array[],
  path: string | undefined,
  maximumBytes: number,
): BufferLease<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let total = 0;
  let release: () => void = () => undefined;
  try {
    for (const chunk of chunks) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
      }
      total += chunk.byteLength;
      context.budget.read(chunk.byteLength);
      if (total > maximumBytes)
        throw new VfsError("E2BIG", "buffered command input limit exceeded");
      release();
      release = context.budget.buffered(total);
      parts.push(decodeUtf8(decoder, chunk, path));
    }
    // The stream path checks once more before the read that reports the end.
    if (context.signal.aborted) {
      throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
    }
    parts.push(decodeUtf8(decoder, undefined, path));
  } catch (error) {
    release();
    throw error;
  }
  return { value: parts.join(""), release };
}

export async function collectText(
  context: ShellCommandContext,
  source: ReadableStream<Uint8Array> | readonly Uint8Array[],
  path?: string,
  maximumBytes = context.budget.limits.maxBufferedBytes,
): Promise<BufferLease<string>> {
  if (Array.isArray(source)) return collectChunkText(context, source, path, maximumBytes);
  const stream = source as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const watched = watchReader(reader, context.signal);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let total = 0;
  let release: () => void = () => undefined;
  let retained = false;
  try {
    while (true) {
      if (watched.aborted) {
        throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
      }
      const result = await watched.read();
      if (result.done) break;
      total += result.value.byteLength;
      chargeConsumed(context.budget, stream, result.value.byteLength);
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
    watched.unwatch();
    reader.releaseLock();
    if (!retained) release();
  }
}

function readFile(context: ShellCommandContext, path: string): InlineReadResult {
  const read = context.fileSystem.readFile(commandPath(context, path));
  fileBody(read.stream);
  return read;
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
    return await collectText(context, fileBody(read.stream), normalized, maximumBytes);
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
  const watched = watchReader(reader, context.signal);
  try {
    while (true) {
      if (watched.aborted) {
        throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
      }
      const result = await watched.read();
      if (result.done) break;
      chargeConsumed(context.budget, stream, result.value.byteLength);
      await sink.write(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    watched.unwatch();
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
