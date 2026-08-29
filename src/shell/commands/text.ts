import { VfsError } from "../../core/errors.js";
import { createLineDiff, renderLineDiff } from "../../core/line-diff.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import {
  BufferedTextWriter,
  type BufferLease,
  collectStream,
  commandPath,
  inputStreams,
  inputTexts,
  parseInteger,
  readFileBytes,
  readTextLines,
  readWithAbort,
  splitLines,
  writeBytes,
  writeText,
} from "./helpers.js";
import type { ParsedUtilityOption } from "./options.js";

export { commCommand, joinCommand } from "./text-compare.js";
export { base64Command, patchCommand, seqCommand } from "./text-extra.js";
export { grepCommand } from "./text-search.js";
export { headCommand, tailCommand } from "./text-slice.js";
export { sortCommand } from "./text-sort.js";
export { wcCommand } from "./text-wc.js";

const TEE = {
  name: "tee",
  usage: "[-a] [FILE...]",
  summary: "copies standard input to standard output and to files",
  options: {
    short: { a: { name: "append" } },
    long: { append: { name: "append" } },
  },
} as const satisfies AppletSpecWithOptions<"append">;

const UNIQ = {
  name: "uniq",
  usage: "[-c] [FILE...]",
  summary: "collapses adjacent duplicate records",
  options: { short: { c: { name: "count" } } },
} as const satisfies AppletSpecWithOptions<"count">;

const CUT = {
  name: "cut",
  usage: "-f LIST [-d DELIM] [-s] | -c LIST [FILE...]",
  summary: "prints selected fields or characters of each record",
  options: {
    short: {
      d: { name: "delimiter", argument: true },
      f: { name: "fields", argument: true },
      c: { name: "characters", argument: true },
      s: { name: "suppress" },
    },
  },
} as const satisfies AppletSpecWithOptions<"delimiter" | "fields" | "characters" | "suppress">;

const TR = {
  name: "tr",
  usage: "SET1 SET2",
  summary: "translates characters between two equal-length sets",
} as const satisfies AppletSpec;

const NL = {
  name: "nl",
  usage: "[FILE...]",
  summary: "numbers non-empty records",
} as const satisfies AppletSpec;

const FOLD = {
  name: "fold",
  usage: "[-w WIDTH] [FILE...]",
  summary: "wraps records to a fixed character width",
  options: { short: { w: { name: "width", argument: true } } },
} as const satisfies AppletSpecWithOptions<"width">;

const PASTE = {
  name: "paste",
  usage: "[FILE...]",
  summary: "merges corresponding records of files into tab-separated rows",
} as const satisfies AppletSpec;

const CMP = {
  name: "cmp",
  usage: "FILE1 FILE2",
  summary: "reports the first differing byte of two files",
} as const satisfies AppletSpec;

const DIFF = {
  name: "diff",
  usage: "FILE1 FILE2",
  summary: "prints a unified difference between two files",
} as const satisfies AppletSpec;

const SHA256SUM = {
  name: "sha256sum",
  usage: "FILE...",
  summary: "prints the SHA-256 digest of each file",
} as const satisfies AppletSpec;
export const teeCommand = /* @__PURE__ */ defineApplet(TEE, async (context, argv, fds) => {
  const parsed = parseAppletOptions(TEE, argv);
  const append = parsed.options.some((option) => option.name === "append");
  const input = await collectStream(context, fds[0]);
  try {
    await writeBytes(fds[1], input.value);
    for (const path of parsed.operands) {
      const normalized = commandPath(context, path);
      if (append) await context.fileSystem.appendFile(normalized, input.value);
      else await context.fileSystem.writeFile(normalized, input.value);
    }
    return 0;
  } finally {
    input.release();
  }
});

export const uniqCommand = /* @__PURE__ */ defineApplet(UNIQ, async (context, argv, fds) => {
  const parsed = parseAppletOptions(UNIQ, argv);
  const count = parsed.options.some((option) => option.name === "count");
  const output = new BufferedTextWriter(context, fds[1]);
  let previous: string | undefined;
  let repeats = 0;
  const emit = async (): Promise<void> => {
    if (previous === undefined) return;
    await output.write(`${count ? `${String(repeats).padStart(7)} ` : ""}${previous}\n`);
  };
  try {
    for await (const input of inputStreams(context, parsed.operands, fds[0])) {
      for await (const line of readTextLines(context, input.stream, input.name)) {
        const value = line.endsWith("\n") ? line.slice(0, -1) : line;
        if (previous === undefined || previous === value) {
          previous = value;
          repeats += 1;
        } else {
          await emit();
          previous = value;
          repeats = 1;
        }
      }
    }
    await emit();
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

interface CutRange {
  readonly start: number;
  readonly end: number;
}

function parseCutRanges(value: string, unit: "character" | "field"): CutRange[] {
  const parts = value.split(/[,\t ]/u);
  if (parts.some((part) => part === "")) {
    throw appletUsageError(CUT, `${unit} list is invalid`);
  }
  const ranges = parts.map((part): CutRange => {
    if (/^\d+$/u.test(part)) {
      const position = parseInteger(part, `${CUT.name}: ${unit}`, 1);
      return { start: position, end: position };
    }
    const range = /^(\d*)-(\d*)$/u.exec(part);
    if (range === null || (range[1] === "" && range[2] === "")) {
      throw appletUsageError(CUT, `${unit} list is invalid`);
    }
    const start = range[1] === "" ? 1 : parseInteger(range[1] ?? "", `${CUT.name}: ${unit}`, 1);
    const end =
      range[2] === ""
        ? Number.POSITIVE_INFINITY
        : parseInteger(range[2] ?? "", `${CUT.name}: ${unit}`, 1);
    if (end < start) throw appletUsageError(CUT, `${unit} range is decreasing`);
    return { start, end };
  });

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CutRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end + 1) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function selectCutValues<T>(values: readonly T[], ranges: readonly CutRange[]): T[] {
  let rangeIndex = 0;
  let range = ranges[rangeIndex];
  return values.filter((_value, index) => {
    const position = index + 1;
    while (range !== undefined && range.end < position) {
      rangeIndex += 1;
      range = ranges[rangeIndex];
    }
    return range !== undefined && range.start <= position;
  });
}

interface CutInvocation {
  readonly operands: readonly string[];
  readonly delimiter: string;
  readonly suppress: boolean;
  readonly fields?: readonly CutRange[];
  readonly characters?: readonly CutRange[];
}

interface MutableCutOptions {
  delimiter: string;
  delimiterSpecified: boolean;
  suppress: boolean;
  fields: CutRange[] | undefined;
  characters: CutRange[] | undefined;
}

function applyCutOption(
  options: MutableCutOptions,
  option: ParsedUtilityOption<"suppress" | "delimiter" | "fields" | "characters">,
): void {
  if (option.name === "suppress") options.suppress = true;
  else if (option.name === "delimiter" && "argument" in option) {
    options.delimiter = option.argument;
    options.delimiterSpecified = true;
  } else if (option.name === "fields" && "argument" in option) {
    options.fields = parseCutRanges(option.argument, "field");
  } else if (option.name === "characters" && "argument" in option) {
    options.characters = parseCutRanges(option.argument, "character");
  }
}

function parseCutInvocation(argv: readonly string[]): CutInvocation {
  const parsed = parseAppletOptions(CUT, argv);
  const options: MutableCutOptions = {
    delimiter: "\t",
    delimiterSpecified: false,
    suppress: false,
    fields: undefined,
    characters: undefined,
  };
  for (const option of parsed.options) applyCutOption(options, option);
  if ((options.fields === undefined) === (options.characters === undefined)) {
    throw appletUsageError(CUT, "specify exactly one of -f or -c");
  }
  if (options.fields === undefined && (options.delimiterSpecified || options.suppress)) {
    throw appletUsageError(CUT, "-d and -s require -f");
  }
  if ([...options.delimiter].length !== 1) {
    throw appletUsageError(CUT, "delimiter must be exactly one character");
  }
  return {
    operands: parsed.operands,
    delimiter: options.delimiter,
    suppress: options.suppress,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.characters === undefined ? {} : { characters: options.characters }),
  };
}

function cutLine(line: string, invocation: CutInvocation): string | undefined {
  const newline = line.endsWith("\n") ? "\n" : "";
  const content = newline === "" ? line : line.slice(0, -1);
  if (invocation.fields === undefined) {
    return selectCutValues([...content], invocation.characters ?? []).join("") + newline;
  }
  if (content.includes(invocation.delimiter)) {
    return (
      selectCutValues(content.split(invocation.delimiter), invocation.fields).join(
        invocation.delimiter,
      ) + newline
    );
  }
  return invocation.suppress ? undefined : content + newline;
}

export const cutCommand = /* @__PURE__ */ defineApplet(CUT, async (context, argv, fds) => {
  const invocation = parseCutInvocation(argv);
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputStreams(context, invocation.operands, fds[0])) {
      for await (const line of readTextLines(context, input.stream, input.name)) {
        const rendered = cutLine(line, invocation);
        if (rendered !== undefined) await output.write(rendered);
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

function characterSet(value: string, context: ShellCommandContext): string[] {
  const characters = [...value];
  const range = characterRange(characters);
  const count = range?.count ?? characters.length;
  if (count > context.budget.limits.maxExpansionChars) {
    throw new VfsError("E2BIG", "tr: character set exceeds the expansion limit");
  }
  context.budget.expansionWork(count);
  return range === undefined
    ? characters
    : Array.from({ length: count }, (_unused, index) => String.fromCodePoint(range.start + index));
}

function characterRange(
  characters: readonly string[],
): { start: number; count: number } | undefined {
  if (characters.length !== 3 || characters[1] !== "-") return undefined;
  const start = characters[0]?.codePointAt(0);
  const end = characters[2]?.codePointAt(0);
  if (start === undefined || end === undefined) return undefined;
  return { start, count: Math.max(0, end - start + 1) };
}

function translateCharacters(
  input: string,
  from: readonly string[],
  to: readonly string[],
): string {
  return [...input]
    .map((character) => {
      const index = from.indexOf(character);
      return index < 0 ? character : (to[Math.min(index, to.length - 1)] ?? "");
    })
    .join("");
}

function decodeTranslated(
  decoder: TextDecoder,
  from: readonly string[],
  to: readonly string[],
  chunk?: Uint8Array,
): string {
  try {
    const decoded =
      chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
    return translateCharacters(decoded, from, to);
  } catch (error) {
    if (error instanceof TypeError) throw new VfsError("EIO", "input is not valid UTF-8");
    throw error;
  }
}

export const trCommand = /* @__PURE__ */ defineApplet(TR, async (context, argv, fds) => {
  if (argv.length !== 2) throw appletUsageError(TR, "requires SET1 and SET2");
  const from = characterSet(argv[0] ?? "", context);
  const to = characterSet(argv[1] ?? "", context);
  const reader = fds[0].getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    while (true) {
      const read = await readWithAbort(reader, context.signal);
      if (read.done) break;
      context.budget.io(read.value.byteLength);
      await output.write(decodeTranslated(decoder, from, to, read.value));
    }
    await output.write(decodeTranslated(decoder, from, to));
    await output.flush();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    output.abort();
  }
  return 0;
});

export const nlCommand = /* @__PURE__ */ defineApplet(NL, async (context, argv, fds) => {
  for (const value of argv) {
    if (value.startsWith("-") && value !== "-") {
      throw appletUsageError(NL, `unsupported option ${value}`);
    }
  }
  let lineNumber = 1;
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputStreams(context, argv, fds[0])) {
      for await (const line of readTextLines(context, input.stream, input.name)) {
        const rendered = numberedLine(line, lineNumber);
        await output.write(rendered.text);
        lineNumber = rendered.next;
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

function numberedLine(line: string, lineNumber: number): { text: string; next: number } {
  const terminated = line.endsWith("\n");
  const content = terminated ? line.slice(0, -1) : line;
  return content.length === 0
    ? { text: `       ${terminated ? "\n" : ""}`, next: lineNumber }
    : { text: `${String(lineNumber).padStart(6)}\t${line}`, next: lineNumber + 1 };
}

async function writeFoldedLine(
  output: BufferedTextWriter,
  line: string,
  width: number,
): Promise<void> {
  const newline = line.endsWith("\n");
  const characters = [...(newline ? line.slice(0, -1) : line)];
  while (characters.length > width) await output.write(`${characters.splice(0, width).join("")}\n`);
  await output.write(`${characters.join("")}${newline ? "\n" : ""}`);
}

export const foldCommand = /* @__PURE__ */ defineApplet(FOLD, async (context, argv, fds) => {
  const parsed = parseAppletOptions(FOLD, argv);
  let width = 80;
  for (const option of parsed.options) {
    if (option.name === "width" && "argument" in option) {
      width = parseInteger(option.argument, `${FOLD.name}: width`, 1);
    }
  }
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputStreams(context, parsed.operands, fds[0])) {
      for await (const line of readTextLines(context, input.stream, input.name)) {
        await writeFoldedLine(output, line, width);
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

export const pasteCommand = /* @__PURE__ */ defineApplet(PASTE, async (context, argv, fds) => {
  const inputs = await inputTexts(context, argv, fds[0]);
  try {
    const columns = inputs.value.map((input) =>
      splitLines(input.text).map((line) => line.replace(/\n$/u, "")),
    );
    const rows = Math.max(0, ...columns.map((column) => column.length));
    let output = "";
    for (let row = 0; row < rows; row += 1) {
      output += `${columns.map((column) => column[row] ?? "").join("\t")}\n`;
    }
    await writeText(fds[1], output);
    return 0;
  } finally {
    inputs.release();
  }
});

export const cmpCommand = /* @__PURE__ */ defineApplet(CMP, async (context, argv, fds) => {
  if (argv.length !== 2) throw appletUsageError(CMP, "requires two files");
  const left = await readFileBytes(context, argv[0] ?? "");
  let right: BufferLease<Uint8Array>;
  try {
    right = await readFileBytes(context, argv[1] ?? "");
  } catch (error) {
    left.release();
    throw error;
  }
  try {
    const length = Math.min(left.value.byteLength, right.value.byteLength);
    for (let index = 0; index < length; index += 1) {
      if (left.value[index] !== right.value[index]) {
        await writeText(fds[1], `${argv[0]} ${argv[1]} differ: byte ${index + 1}\n`);
        return 1;
      }
    }
    if (left.value.byteLength !== right.value.byteLength) {
      await writeText(fds[1], `${argv[0]} ${argv[1]} differ: byte ${length + 1}\n`);
      return 1;
    }
    return 0;
  } finally {
    left.release();
    right.release();
  }
});

export const diffCommand = /* @__PURE__ */ defineApplet(DIFF, async (context, argv, fds) => {
  if (argv.length !== 2) throw appletUsageError(DIFF, "requires two files");
  const inputs = await inputTexts(context, argv, fds[0]);
  try {
    const diff = createLineDiff(inputs.value[0]?.text ?? "", inputs.value[1]?.text ?? "");
    if (diff.changes === 0) return 0;
    await writeText(fds[1], renderLineDiff(argv[0] ?? "", argv[1] ?? "", diff));
    return 1;
  } finally {
    inputs.release();
  }
});

export const sha256sumCommand = /* @__PURE__ */ defineApplet(
  SHA256SUM,
  async (context, argv, fds) => {
    if (argv.length === 0) throw appletUsageError(SHA256SUM, "missing operand");
    for (const path of argv) {
      const digest = await context.fileSystem.digestFile(commandPath(context, path));
      await writeText(fds[1], `${digest}  ${path}\n`);
    }
    return 0;
  },
);
