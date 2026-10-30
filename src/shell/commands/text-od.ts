import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { BufferedTextWriter, parseInteger, readWithAbort } from "./helpers.js";
import { inputStreams } from "./inputs.js";

const OD = {
  name: "od",
  usage: "[-bcdovx] [-A RADIX] [-t TYPE]... [-j SKIP] [-N COUNT] [-w WIDTH] [FILE...]",
  summary: "dumps bytes in octal, hexadecimal, decimal, or characters",
  options: {
    short: {
      A: { name: "address-radix", argument: true },
      t: { name: "format", argument: true },
      j: { name: "skip-bytes", argument: true },
      N: { name: "read-bytes", argument: true },
      w: { name: "width", argument: true },
      v: { name: "output-duplicates" },
      b: { name: "octal-bytes" },
      c: { name: "characters" },
      d: { name: "unsigned-shorts" },
      o: { name: "octal-shorts" },
      x: { name: "hex-shorts" },
    },
    long: {
      "address-radix": { name: "address-radix", argument: true },
      format: { name: "format", argument: true },
      "skip-bytes": { name: "skip-bytes", argument: true },
      "read-bytes": { name: "read-bytes", argument: true },
      width: { name: "width", argument: true },
      "output-duplicates": { name: "output-duplicates" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  | "address-radix"
  | "format"
  | "skip-bytes"
  | "read-bytes"
  | "width"
  | "output-duplicates"
  | "octal-bytes"
  | "characters"
  | "unsigned-shorts"
  | "octal-shorts"
  | "hex-shorts"
>;

type OdKind = "a" | "c" | "d" | "o" | "u" | "x";

interface OdFormat {
  readonly kind: OdKind;
  readonly size: number;
  /** Characters of one element, before alignment with the other formats. */
  readonly width: number;
  /** `z`: the printable bytes of the line, after the elements. */
  readonly printable: boolean;
}

/** Element widths GNU uses for each kind and size. */
const WIDTHS: Readonly<Record<string, number>> = {
  o1: 3,
  o2: 6,
  o4: 11,
  o8: 22,
  x1: 2,
  x2: 4,
  x4: 8,
  x8: 16,
  u1: 3,
  u2: 5,
  u4: 10,
  u8: 20,
  d1: 4,
  d2: 6,
  d4: 11,
  d8: 20,
};

const SIZE_LETTERS: Readonly<Record<string, number>> = { C: 1, S: 2, I: 4, L: 8 };

const CHARACTER_ESCAPES: Readonly<Record<number, string>> = {
  0: "\\0",
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r",
};

const NAMED_CHARACTERS = [
  "nul",
  "soh",
  "stx",
  "etx",
  "eot",
  "enq",
  "ack",
  "bel",
  "bs",
  "ht",
  "nl",
  "vt",
  "ff",
  "cr",
  "so",
  "si",
  "dle",
  "dc1",
  "dc2",
  "dc3",
  "dc4",
  "nak",
  "syn",
  "etb",
  "can",
  "em",
  "sub",
  "esc",
  "fs",
  "gs",
  "rs",
  "us",
  "sp",
];

function oneFormat(
  kind: OdKind,
  sizeText: string | undefined,
  printable: boolean,
  value: string,
): OdFormat {
  if (kind === "a" || kind === "c") {
    if (sizeText !== undefined) throw appletUsageError(OD, `invalid type string ${value}`);
    return { kind, size: 1, width: 3, printable };
  }
  // GNU's default integer size is that of an int.
  const size = sizeText === undefined ? 4 : (SIZE_LETTERS[sizeText] ?? Number(sizeText));
  const width = WIDTHS[`${kind}${size}`];
  if (width === undefined) throw appletUsageError(OD, `invalid type size in ${value}`);
  return { kind, size, width, printable };
}

/** Parses `-t` specifications such as `x1`, `c`, `o2`, `dI` or `x1z`, several per argument. */
function parseFormats(value: string): OdFormat[] {
  const formats: OdFormat[] = [];
  const pattern = /([acdoux])([0-9]+|[CSIL])?(z?)/gy;
  let consumed = 0;
  for (const match of value.matchAll(pattern)) {
    consumed = (match.index ?? 0) + match[0].length;
    formats.push(oneFormat(match[1] as OdKind, match[2], match[3] === "z", value));
  }
  if (formats.length === 0 || consumed !== value.length) {
    throw appletUsageError(OD, `invalid type string ${value}`);
  }
  return formats;
}

function characterCell(byte: number, named: boolean): string {
  if (named) {
    const low = byte & 0x7f;
    if (low === 0x7f) return "del";
    return NAMED_CHARACTERS[low] ?? String.fromCharCode(low);
  }
  const escaped = CHARACTER_ESCAPES[byte];
  if (escaped !== undefined) return escaped;
  if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
  return byte.toString(8).padStart(3, "0");
}

/** One little-endian element, as the integer kinds print it. */
function integerCell(bytes: Uint8Array, offset: number, format: OdFormat): string {
  let value = 0n;
  for (let index = format.size - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  }
  if (format.kind === "d") value = BigInt.asIntN(format.size * 8, value);
  const radix = format.kind === "o" ? 8 : format.kind === "x" ? 16 : 10;
  const text = value.toString(radix);
  return format.kind === "o" || format.kind === "x" ? text.padStart(format.width, "0") : text;
}

/**
 * Widens each element so that every format's columns line up, as GNU does when
 * several `-t` types share a line: each byte gets the room the widest needs.
 */
function alignedWidths(formats: readonly OdFormat[]): number[] {
  const perByte = Math.max(...formats.map((format) => (format.width + 1) / format.size));
  return formats.map((format) => Math.ceil(perByte * format.size) - 1);
}

interface OdLayout {
  readonly formats: readonly OdFormat[];
  readonly widths: readonly number[];
  readonly radix: "o" | "d" | "x" | "n";
  readonly perLine: number;
  readonly duplicates: boolean;
}

function address(offset: number, radix: OdLayout["radix"]): string {
  if (radix === "n") return "";
  if (radix === "x") return offset.toString(16).padStart(6, "0");
  return offset.toString(radix === "o" ? 8 : 10).padStart(7, "0");
}

function lineText(bytes: Uint8Array, offset: number, layout: OdLayout): string {
  const lines: string[] = [];
  layout.formats.forEach((format, index) => {
    const width = layout.widths[index] ?? format.width;
    const cells: string[] = [];
    for (let at = 0; at < bytes.length; at += format.size) {
      const cell =
        format.kind === "a" || format.kind === "c"
          ? characterCell(bytes[at] ?? 0, format.kind === "a")
          : integerCell(bytes, at, format);
      cells.push(` ${cell.padStart(width)}`);
    }
    const prefix =
      index === 0 ? address(offset, layout.radix) : " ".repeat(address(0, layout.radix).length);
    const printable = format.printable
      ? `${" ".repeat(Math.max(0, (layout.perLine - bytes.length) / format.size) * (width + 1))}  >${[...bytes].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("")}<`
      : "";
    lines.push(`${prefix}${cells.join("")}${printable}\n`);
  });
  return lines.join("");
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

/** Formats lines as bytes arrive, folding repeated lines into `*` unless `-v`. */
class OdWriter {
  private pending: number[] = [];
  private offset: number;
  private previous: Uint8Array | undefined;
  private folded = false;

  constructor(
    private readonly output: BufferedTextWriter,
    private readonly layout: OdLayout,
    start: number,
  ) {
    this.offset = start;
  }

  async add(byte: number): Promise<void> {
    this.pending.push(byte);
    if (this.pending.length === this.layout.perLine) await this.line();
  }

  async finish(): Promise<void> {
    if (this.pending.length > 0) await this.line();
    await this.output.write(
      this.layout.radix === "n" ? "" : `${address(this.offset, this.layout.radix)}\n`,
    );
  }

  private async line(): Promise<void> {
    const bytes = Uint8Array.from(this.pending);
    this.pending = [];
    const repeated = !this.layout.duplicates && sameBytes(this.previous, bytes);
    if (repeated) {
      if (!this.folded) await this.output.write("*\n");
      this.folded = true;
    } else {
      this.folded = false;
      await this.output.write(lineText(bytes, this.offset, this.layout));
    }
    this.previous = bytes;
    this.offset += bytes.length;
  }
}

function legacyFormats(name: string): string | undefined {
  if (name === "octal-bytes") return "o1";
  if (name === "characters") return "c";
  if (name === "unsigned-shorts") return "u2";
  if (name === "octal-shorts") return "o2";
  if (name === "hex-shorts") return "x2";
  return undefined;
}

function addressRadix(value: string): OdLayout["radix"] {
  if (!/^[odxn]$/u.test(value)) throw appletUsageError(OD, "-A must be d, o, x, or n");
  return value as OdLayout["radix"];
}

function layoutFor(parsed: ReturnType<typeof parseAppletOptions<string>>): OdLayout {
  const formats: OdFormat[] = [];
  let radix: OdLayout["radix"] = "o";
  let perLine = 16;
  for (const option of parsed.options) {
    const legacy = legacyFormats(option.name);
    if (legacy !== undefined) formats.push(...parseFormats(legacy));
    if (!("argument" in option)) continue;
    if (option.name === "format") formats.push(...parseFormats(option.argument));
    if (option.name === "address-radix") radix = addressRadix(option.argument);
    if (option.name === "width") perLine = parseInteger(option.argument, "od: width", 1);
  }
  const chosen = formats.length === 0 ? parseFormats("o2") : formats;
  const largest = Math.max(...chosen.map((format) => format.size));
  if (perLine % largest !== 0) throw appletUsageError(OD, "width must be a multiple of every size");
  return {
    formats: chosen,
    widths: alignedWidths(chosen),
    radix,
    perLine,
    duplicates: parsed.options.some((option) => option.name === "output-duplicates"),
  };
}

function byteCount(
  parsed: ReturnType<typeof parseAppletOptions<string>>,
  name: string,
): number | undefined {
  const option = parsed.options.filter((candidate) => candidate.name === name).at(-1);
  return option !== undefined && "argument" in option
    ? parseInteger(option.argument, `od: ${name}`)
    : undefined;
}

/**
 * Dumps bytes as GNU `od` does: addresses, `-t` element formats with their
 * column widths and alignment, `*` for repeated lines, and the final address.
 */
/** Feeds every byte after `skip` to the writer, at most `count` of them. */
class OdInput {
  constructor(
    private skip: number,
    private remaining: number,
  ) {}

  get done(): boolean {
    return this.remaining <= 0;
  }

  async feed(chunk: Uint8Array, writer: OdWriter): Promise<void> {
    const start = Math.min(this.skip, chunk.length);
    this.skip -= start;
    const end = Math.min(chunk.length, start + this.remaining);
    this.remaining -= end - start;
    for (let index = start; index < end; index += 1) await writer.add(chunk[index] ?? 0);
  }
}

export const odCommand = /* @__PURE__ */ defineApplet(OD, async (context, argv, fds) => {
  const parsed = parseAppletOptions(OD, argv);
  const layout = layoutFor(parsed);
  const skip = byteCount(parsed, "skip-bytes") ?? 0;
  const input = new OdInput(skip, byteCount(parsed, "read-bytes") ?? Number.POSITIVE_INFINITY);
  const output = new BufferedTextWriter(context, fds[1]);
  const writer = new OdWriter(output, layout, skip);
  try {
    for await (const operand of inputStreams(context, parsed.operands, fds[0])) {
      const reader = operand.stream.getReader();
      try {
        while (!input.done) {
          const read = await readWithAbort(reader, context.signal);
          if (read.done) break;
          context.budget.io(read.value.byteLength);
          await input.feed(read.value, writer);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    await writer.finish();
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});
