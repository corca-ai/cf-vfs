import type { ShellCommandContext, ShellSink } from "../types.js";
import { readWithAbort, writeBytes } from "./helpers.js";

/** `cat` display options, which apply to the concatenated stream as one. */
export interface CatFormat {
  readonly number: boolean;
  readonly numberNonBlank: boolean;
  readonly squeeze: boolean;
  readonly showEnds: boolean;
  readonly showTabs: boolean;
  readonly showNonPrinting: boolean;
}

const encoder = new TextEncoder();

/** GNU's `-v` notation: `^X` for controls, `^?` for DEL, `M-` for the high half. */
function visible(byte: number, format: CatFormat, output: number[]): void {
  if (byte === 0x09 && format.showTabs) {
    output.push(0x5e, 0x49);
    return;
  }
  if (!format.showNonPrinting || byte === 0x09 || byte === 0x0a) {
    output.push(byte);
    return;
  }
  let low = byte;
  if (low >= 0x80) {
    output.push(0x4d, 0x2d);
    low -= 0x80;
  }
  if (low < 0x20) output.push(0x5e, low + 0x40);
  else if (low === 0x7f) output.push(0x5e, 0x3f);
  else output.push(low);
}

/** Formats bytes as they stream, carrying line state across chunks and inputs. */
export class CatFormatter {
  private atLineStart = true;
  private blankRun = 0;
  private line = 0;

  constructor(private readonly format: CatFormat) {}

  transform(chunk: Uint8Array): Uint8Array {
    const output: number[] = [];
    for (const byte of chunk) {
      if (this.atLineStart && !this.beginLine(byte === 0x0a, output)) continue;
      if (byte === 0x0a) {
        if (this.format.showEnds) output.push(0x24);
        output.push(0x0a);
        this.atLineStart = true;
        continue;
      }
      this.atLineStart = false;
      visible(byte, this.format, output);
    }
    return Uint8Array.from(output);
  }

  /** Starts a line, returning false for a blank line `-s` drops. */
  private beginLine(blank: boolean, output: number[]): boolean {
    this.blankRun = blank ? this.blankRun + 1 : 0;
    if (blank && this.format.squeeze && this.blankRun > 1) return false;
    this.startLine(blank, output);
    return true;
  }

  private startLine(blank: boolean, output: number[]): void {
    const numbered = this.format.numberNonBlank ? !blank : this.format.number;
    if (!numbered) return;
    this.line += 1;
    for (const byte of encoder.encode(`${String(this.line).padStart(6)}\t`)) output.push(byte);
  }
}

export async function formatToSink(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
  sink: ShellSink,
  formatter: CatFormatter,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const read = await readWithAbort(reader, context.signal);
      if (read.done) return;
      context.budget.io(read.value.byteLength);
      await writeBytes(sink, formatter.transform(read.value));
    }
  } finally {
    reader.releaseLock();
  }
}
