import { VfsError } from "../../core/errors.js";
import type { ByteRange } from "../../vfs/types.js";
import type { ShellCommandContext, ShellSink } from "../types.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import {
  collectStream,
  inputTexts,
  parseInteger,
  readWithAbort,
  splitLines,
  writeBytes,
  writeText,
} from "./helpers.js";
import { inputStreams } from "./inputs.js";

/** Shared by `head` and `tail`, which accept the same option spellings. */
const SLICE_OPTIONS = {
  short: {
    n: { name: "lines", argument: true },
    c: { name: "bytes", argument: true },
    q: { name: "quiet" },
    v: { name: "verbose" },
  },
  long: {
    lines: { name: "lines", argument: true },
    bytes: { name: "bytes", argument: true },
    quiet: { name: "quiet" },
    silent: { name: "quiet" },
    verbose: { name: "verbose" },
  },
  oldStyleCount: "lines",
} as const;

type SliceOption = "lines" | "bytes" | "quiet" | "verbose";

const HEAD = {
  name: "head",
  usage: "[-qv] [-n COUNT] [-c BYTES] [FILE...]",
  summary: "prints the leading records or bytes of its input",
  options: SLICE_OPTIONS,
} as const satisfies AppletSpecWithOptions<SliceOption>;

const TAIL = {
  name: "tail",
  usage: "[-qv] [-n [+]COUNT] [-c [+]BYTES] [FILE...]",
  summary: "prints the trailing records or bytes of its input",
  options: SLICE_OPTIONS,
} as const satisfies AppletSpecWithOptions<SliceOption>;

interface SliceInvocation {
  readonly count: number;
  readonly bytes: boolean;
  /** `tail -n +N`: start at record N rather than keep the last N. */
  readonly fromStart: boolean;
  readonly paths: readonly string[];
  readonly headers: boolean;
}

function sliceCount(
  spec: AppletSpecWithOptions<SliceOption>,
  argv: readonly string[],
  defaultCount: number,
): SliceInvocation {
  const parsed = parseAppletOptions(spec, argv);
  let count = defaultCount;
  let bytes = false;
  let fromStart = false;
  let headers: boolean | undefined;
  for (const option of parsed.options) {
    if (option.name === "quiet") headers = false;
    else if (option.name === "verbose") headers = true;
    if (!("argument" in option)) continue;
    bytes = option.name === "bytes";
    fromStart = spec === TAIL && option.argument.startsWith("+");
    const value = fromStart ? option.argument.slice(1) : option.argument;
    count = parseInteger(value, `${spec.name}: ${bytes ? "byte" : "line"} count`);
  }
  const paths = parsed.operands;
  return { count, bytes, fromStart, paths, headers: headers ?? paths.length > 1 };
}

/** GNU names each file before its slice when there is more than one. */
async function writeHeader(sink: ShellSink, name: string, first: boolean): Promise<void> {
  await writeText(sink, `${first ? "" : "\n"}==> ${name === "-" ? "standard input" : name} <==\n`);
}

class HeadLineAccount {
  private currentLineBytes = 0;
  private records = 0;

  constructor(
    private readonly context: ShellCommandContext,
    private readonly path: string,
  ) {}

  account(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.currentLineBytes += 1;
      if (this.currentLineBytes > this.context.budget.limits.maxLineBytes) {
        throw new VfsError("E2BIG", "line byte limit exceeded", this.path);
      }
      if (byte === 0x0a) this.completeRecord();
    }
  }

  finish(): void {
    if (this.currentLineBytes > 0) this.completeRecord();
  }

  private completeRecord(): void {
    this.currentLineBytes = 0;
    this.records += 1;
    if (this.records > this.context.budget.limits.maxBufferedRecords) {
      throw new VfsError("E2BIG", "input record limit exceeded", this.path);
    }
  }
}

function decodeHead(
  decoder: TextDecoder,
  bytes: Uint8Array | undefined,
  stream: boolean,
  path: string,
): string {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream });
  } catch {
    throw new VfsError("EIO", "input is not valid UTF-8", path);
  }
}

function limitedLines(
  bytes: Uint8Array,
  remaining: number,
): { bytes: Uint8Array; remaining: number } {
  let end = bytes.byteLength;
  let left = remaining;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a && --left === 0) {
      end = index + 1;
      break;
    }
  }
  return { bytes: bytes.slice(0, end), remaining: left };
}

async function headBytes(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  count: number,
  sink: ShellSink,
): Promise<void> {
  const reader = stream.getReader();
  let remaining = count;
  let finished = false;
  try {
    if (remaining === 0) {
      await reader.cancel(new VfsError("EPIPE", "head reached its limit"));
      return;
    }
    while (remaining > 0) {
      const result = await readWithAbort(reader, context.signal);
      if (result.done) {
        finished = true;
        break;
      }
      context.budget.io(result.value.byteLength);
      const output = result.value.slice(0, remaining);
      await writeBytes(sink, output);
      remaining -= output.byteLength;
      if (output.byteLength < result.value.byteLength || remaining === 0) {
        await reader.cancel(new VfsError("EPIPE", "head reached its byte limit"));
        break;
      }
    }
  } finally {
    if (!finished && remaining > 0) {
      await reader
        .cancel(new VfsError("EPIPE", "head stopped reading input"))
        .catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function headLines(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  path: string,
  count: number,
  sink: ShellSink,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const account = new HeadLineAccount(context, path);
  let remaining = count;
  let finished = false;
  try {
    while (remaining > 0) {
      const result = await readWithAbort(reader, context.signal);
      if (result.done) {
        account.finish();
        await writeText(sink, decodeHead(decoder, undefined, false, path));
        finished = true;
        break;
      }
      context.budget.io(result.value.byteLength);
      const limited = limitedLines(result.value, remaining);
      remaining = limited.remaining;
      account.account(limited.bytes);
      await writeText(sink, decodeHead(decoder, limited.bytes, remaining > 0, path));
      if (remaining === 0) {
        await reader.cancel(new VfsError("EPIPE", "head reached its line limit"));
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (!finished && remaining > 0) {
      await reader
        .cancel(new VfsError("EPIPE", "head stopped reading input"))
        .catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export const headCommand = /* @__PURE__ */ defineApplet(HEAD, async (context, argv, fds) => {
  const options = sliceCount(HEAD, argv, 10);
  const wanted: ByteRange | undefined =
    options.bytes && options.count > 0 ? { offset: 0, length: options.count } : undefined;
  let first = true;
  for await (const input of inputStreams(context, options.paths, fds[0], wanted)) {
    if (options.headers) await writeHeader(fds[1], input.name, first);
    first = false;
    if (options.bytes) await headBytes(context, input.stream, options.count, fds[1]);
    else if (options.count === 0) {
      await input.stream.cancel(new VfsError("EPIPE", "head reached its line limit"));
    } else await headLines(context, input.stream, input.name, options.count, fds[1]);
  }
  return 0;
});

function tailSlice<T>(
  items: { slice(start: number): T; length: number },
  options: SliceInvocation,
): T {
  if (options.fromStart) return items.slice(Math.max(0, options.count - 1));
  return items.slice(Math.max(0, items.length - options.count));
}

export const tailCommand = /* @__PURE__ */ defineApplet(TAIL, async (context, argv, fds) => {
  const options = sliceCount(TAIL, argv, 10);
  let first = true;
  if (options.bytes) {
    const wanted: ByteRange | undefined =
      options.count > 0 && !options.fromStart ? { suffix: options.count } : undefined;
    for await (const input of inputStreams(context, options.paths, fds[0], wanted)) {
      if (options.headers) await writeHeader(fds[1], input.name, first);
      first = false;
      const collected = await collectStream(context, input.stream);
      try {
        const bytes = collected.value;
        await writeBytes(
          fds[1],
          tailSlice({ slice: (start) => bytes.slice(start), length: bytes.byteLength }, options),
        );
      } finally {
        collected.release();
      }
    }
    return 0;
  }
  const collected = await inputTexts(context, options.paths, fds[0]);
  try {
    for (const input of collected.value) {
      if (options.headers) await writeHeader(fds[1], input.name, first);
      first = false;
      await writeText(fds[1], tailSlice(splitLines(input.text), options).join(""));
    }
    return 0;
  } finally {
    collected.release();
  }
});
