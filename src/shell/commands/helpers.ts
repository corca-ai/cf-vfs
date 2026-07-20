import { VfsError } from "../../core/errors.js";
import { normalizePath } from "../../core/path.js";
import type { InlineReadResult } from "../../vfs/types.js";
import type {
  ShellCommand,
  ShellCommandContext,
  ShellFileDescriptors,
  ShellProcess,
  ShellSink,
} from "../types.js";

export type CommandRunner = (
  context: ShellCommandContext,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) => Promise<number> | number;

export interface BufferLease<T> {
  value: T;
  release(): void;
}

/* @__NO_SIDE_EFFECTS__ */
export function defineCommand(name: string, runner: CommandRunner): ShellCommand {
  return {
    name,
    run(context, argv, fds): ShellProcess {
      return {
        completed: Promise.resolve().then(async () => ({ exitCode: await runner(context, argv, fds) })),
      };
    },
  };
}

export function commandPath(context: ShellCommandContext, path = "."): string {
  return normalizePath(path, context.session.cwd);
}

export async function writeBytes(sink: ShellSink, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 0) await sink.write(bytes);
}

export async function writeText(sink: ShellSink, value: string): Promise<void> {
  await writeBytes(sink, new TextEncoder().encode(value));
}

export async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const cancellation = (): VfsError => signal.reason instanceof VfsError
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
    void reader.read().then(resolve, reject).finally(() => {
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
    const bytes = new TextEncoder().encode(value).byteLength;
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
): AsyncGenerator<{ name: string; stream: ReadableStream<Uint8Array> }> {
  if (argv.length === 0) {
    yield { name: "-", stream: stdin };
    return;
  }
  for (const path of argv) {
    if (path === "-") yield { name: "-", stream: stdin };
    else yield { name: path, stream: (await readFile(context, path)).stream };
  }
}

export async function* readTextLines(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  path?: string,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  let finished = false;
  let records = 0;
  try {
    while (true) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
      }
      const read = await readWithAbort(reader, context.signal);
      if (read.done) {
        try {
          pending += decoder.decode();
        } catch {
          throw new VfsError("EIO", "input is not valid UTF-8", path);
        }
        finished = true;
        break;
      }
      context.budget.io(read.value.byteLength);
      try {
        pending += decoder.decode(read.value, { stream: true });
      } catch {
        throw new VfsError("EIO", "input is not valid UTF-8", path);
      }
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (encoder.encode(line).byteLength > context.budget.limits.maxLineBytes) {
          throw new VfsError("E2BIG", "line byte limit exceeded", path);
        }
        context.budget.step();
        records += 1;
        if (records > context.budget.limits.maxBufferedRecords) {
          throw new VfsError("E2BIG", "input record limit exceeded", path);
        }
        yield line;
      }
      if (encoder.encode(pending).byteLength > context.budget.limits.maxLineBytes) {
        throw new VfsError("E2BIG", "line byte limit exceeded", path);
      }
    }
    if (pending.length > 0) {
      context.budget.step();
      records += 1;
      if (records > context.budget.limits.maxBufferedRecords) {
        throw new VfsError("E2BIG", "input record limit exceeded", path);
      }
      yield pending;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (!finished) await reader.cancel(new VfsError("EPIPE", "line consumer stopped early")).catch(() => undefined);
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
    while (true) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
      }
      const result = await readWithAbort(reader, context.signal);
      if (result.done) break;
      total += result.value.byteLength;
      context.budget.io(result.value.byteLength);
      if (total > maximumBytes) throw new VfsError("E2BIG", "buffered command input limit exceeded");
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
  maximumBytes?: number,
): Promise<BufferLease<string>> {
  const bytes = await collectStream(context, stream, maximumBytes);
  try {
    return {
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes.value),
      release: bytes.release,
    };
  } catch {
    bytes.release();
    throw new VfsError("EIO", "input is not valid UTF-8", path);
  }
}

export async function readFile(
  context: ShellCommandContext,
  path: string,
): Promise<InlineReadResult> {
  return await context.fileSystem.readFile(commandPath(context, path));
}

export async function readFileBytes(
  context: ShellCommandContext,
  path: string,
): Promise<BufferLease<Uint8Array>> {
  const read = await readFile(context, path);
  return await collectStream(context, read.stream);
}

export async function readFileText(
  context: ShellCommandContext,
  path: string,
  maximumBytes?: number,
): Promise<BufferLease<string>> {
  const normalized = commandPath(context, path);
  const read = await context.fileSystem.readFile(normalized);
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
  if (value.length === 0) return [];
  const lines = value.match(/[^\n]*(?:\n|$)/gu) ?? [];
  if (lines.at(-1) === "") lines.pop();
  return lines;
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
      const collected = path === "-"
        ? await collectText(context, stdin)
        : await readFileText(context, path);
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
