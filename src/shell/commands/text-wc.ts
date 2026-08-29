import { VfsError } from "../../core/errors.js";
import type { InlineReadResult } from "../../vfs/types.js";
import type { ShellCommandContext } from "../types.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { commandPath, inputStreams, readWithAbort, writeText } from "./helpers.js";

const WC = {
  name: "wc",
  usage: "[-lwc] [FILE...]",
  summary: "counts records, words, and bytes",
  options: {
    short: {
      l: { name: "lines" },
      w: { name: "words" },
      c: { name: "bytes" },
    },
  },
} as const satisfies AppletSpecWithOptions<"lines" | "words" | "bytes">;

const C_WHITESPACE = " \t\n\v\f\r";

interface WcSelection {
  readonly lines: boolean;
  readonly words: boolean;
  readonly bytes: boolean;
}

interface WcCounts {
  readonly lines: number;
  readonly words: number;
  readonly bytes: number;
}

function wcSelection(argv: readonly string[]): {
  readonly selection: WcSelection;
  readonly operands: readonly (string | undefined)[];
} {
  const parsed = parseAppletOptions(WC, argv);
  const requested = {
    lines: parsed.options.some((option) => option.name === "lines"),
    words: parsed.options.some((option) => option.name === "words"),
    bytes: parsed.options.some((option) => option.name === "bytes"),
  };
  const defaults = !requested.lines && !requested.words && !requested.bytes;
  return {
    selection: defaults ? { lines: true, words: true, bytes: true } : requested,
    operands: parsed.operands.length === 0 ? [undefined] : parsed.operands,
  };
}

async function wcMetadataBytes(
  context: ShellCommandContext,
  operand: string | undefined,
  selection: WcSelection,
): Promise<number | undefined> {
  if (
    !selection.bytes ||
    selection.lines ||
    selection.words ||
    operand === undefined ||
    operand === "-"
  ) {
    return undefined;
  }
  let read: InlineReadResult;
  try {
    read = context.fileSystem.readFile(commandPath(context, operand), {
      range: { offset: 0, length: 1 },
    });
  } catch (error) {
    // Opaque content still has to be streamed so transport failures remain
    // observable. Inline SQLite bytes are immutable and their entry size is
    // maintained transactionally, so reading one byte proves access and kind.
    if (error instanceof VfsError && error.code === "ENOTSUP") return undefined;
    throw error;
  }
  await read.stream.cancel();
  return read.stat.sizeBytes;
}

function countWords(
  text: string,
  inWord: boolean,
): { readonly words: number; readonly inWord: boolean } {
  let words = 0;
  let inside = inWord;
  for (const character of text) {
    if (C_WHITESPACE.includes(character)) inside = false;
    else if (!inside) {
      words += 1;
      inside = true;
    }
  }
  return { words, inWord: inside };
}

class WcTextCounter {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #path: string;
  readonly #countWords: boolean;
  #words = 0;
  #inWord = false;

  constructor(path: string, countWordValues: boolean) {
    this.#path = path;
    this.#countWords = countWordValues;
  }

  get words(): number {
    return this.#words;
  }

  write(chunk?: Uint8Array): void {
    try {
      const text =
        chunk === undefined
          ? this.#decoder.decode()
          : this.#decoder.decode(chunk, { stream: true });
      if (!this.#countWords) return;
      const counted = countWords(text, this.#inWord);
      this.#words += counted.words;
      this.#inWord = counted.inWord;
    } catch {
      throw new VfsError("EIO", "input is not valid UTF-8", this.#path);
    }
  }
}

function newlineCount(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}

async function wcStream(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  path: string,
  selection: WcSelection,
): Promise<WcCounts> {
  const reader = stream.getReader();
  const text =
    selection.lines || selection.words ? new WcTextCounter(path, selection.words) : undefined;
  let lines = 0;
  let bytes = 0;
  try {
    for (;;) {
      const read = await readWithAbort(reader, context.signal);
      if (read.done) break;
      context.budget.io(read.value.byteLength);
      bytes += read.value.byteLength;
      if (selection.lines) lines += newlineCount(read.value);
      text?.write(read.value);
    }
    text?.write();
    return { lines, words: text?.words ?? 0, bytes };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function wcFields(counts: WcCounts, selection: WcSelection): number[] {
  const fields: number[] = [];
  if (selection.lines) fields.push(counts.lines);
  if (selection.words) fields.push(counts.words);
  if (selection.bytes) fields.push(counts.bytes);
  return fields;
}

export const wcCommand = /* @__PURE__ */ defineApplet(WC, async (context, argv, fds) => {
  const { selection, operands } = wcSelection(argv);
  for (const operand of operands) {
    const metadataBytes = await wcMetadataBytes(context, operand, selection);
    if (metadataBytes !== undefined) {
      await writeText(fds[1], `${metadataBytes} ${operand}\n`);
      continue;
    }
    for await (const input of inputStreams(
      context,
      operand === undefined ? [] : [operand],
      fds[0],
    )) {
      const counts = await wcStream(context, input.stream, input.name, selection);
      const fields = wcFields(counts, selection);
      await writeText(fds[1], `${fields.join(" ")}${input.name === "-" ? "" : ` ${input.name}`}\n`);
    }
  }
  return 0;
});
