import { VfsError } from "../../core/errors.js";
import { createLineDiff, renderLineDiff } from "../../core/line-diff.js";
import { compareUtf8 } from "../../core/path.js";
import { compilePosixRegex } from "../../core/posix-regex.js";
import { applyUnifiedPatch } from "../../core/unified-patch.js";
import type { ByteRange } from "../../vfs/types.js";
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
  collectText,
  commandPath,
  contentInputs,
  inputStreams,
  inputTexts,
  parseInteger,
  readFileBytes,
  readFileText,
  readTextLines,
  readWithAbort,
  recursiveInputs,
  splitLines,
  writeBytes,
  writeText,
} from "./helpers.js";

const SORT = {
  name: "sort",
  usage: "[-nru] [FILE...]",
  summary: "sorts records by UTF-8 byte order, or numerically with -n",
  options: {
    short: {
      r: { name: "reverse" },
      u: { name: "unique" },
      n: { name: "numeric" },
    },
  },
} as const satisfies AppletSpecWithOptions<"reverse" | "unique" | "numeric">;

const GREP = {
  name: "grep",
  usage: "[-cinvFElqrRh] PATTERN [PATH...]",
  summary: "prints records matching a pattern",
  options: {
    short: {
      i: { name: "ignore-case" },
      v: { name: "invert" },
      n: { name: "line-numbers" },
      F: { name: "fixed" },
      E: { name: "extended" },
      c: { name: "count" },
      l: { name: "files-with-matches" },
      q: { name: "quiet" },
      r: { name: "recursive" },
      R: { name: "recursive" },
      h: { name: "no-filename" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  | "ignore-case"
  | "invert"
  | "line-numbers"
  | "fixed"
  | "extended"
  | "count"
  | "files-with-matches"
  | "quiet"
  | "recursive"
  | "no-filename"
>;

/** Shared by `head` and `tail`, which accept the same option spellings. */
const SLICE_OPTIONS = {
  short: {
    n: { name: "lines", argument: true },
    c: { name: "bytes", argument: true },
  },
  long: {
    lines: { name: "lines", argument: true },
    bytes: { name: "bytes", argument: true },
  },
  oldStyleCount: "lines",
} as const;

const HEAD = {
  name: "head",
  usage: "[-n COUNT] [-c BYTES] [FILE...]",
  summary: "prints the leading records or bytes of its input",
  options: SLICE_OPTIONS,
} as const satisfies AppletSpecWithOptions<"lines" | "bytes">;

const TAIL = {
  name: "tail",
  usage: "[-n COUNT] [-c BYTES] [FILE...]",
  summary: "prints the trailing records or bytes of its input",
  options: SLICE_OPTIONS,
} as const satisfies AppletSpecWithOptions<"lines" | "bytes">;

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
  usage: "-f LIST [-d DELIM] | -c LIST [FILE...]",
  summary: "prints selected fields or characters of each record",
  options: {
    short: {
      d: { name: "delimiter", argument: true },
      f: { name: "fields", argument: true },
      c: { name: "characters", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<"delimiter" | "fields" | "characters">;

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

const COMM = {
  name: "comm",
  usage: "[-123] [--nocheck-order] FILE1 FILE2",
  summary: "compares two sorted files record by record",
  options: {
    short: {
      1: { name: "suppress-left" },
      2: { name: "suppress-right" },
      3: { name: "suppress-common" },
    },
    long: {
      "nocheck-order": { name: "no-check-order" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "suppress-left" | "suppress-right" | "suppress-common" | "no-check-order"
>;

const JOIN = {
  name: "join",
  usage: "[-t DELIM] [-1 FIELD] [-2 FIELD] [-a 1|2] FILE1 FILE2",
  summary: "joins two sorted files on a common field",
  options: {
    short: {
      t: { name: "delimiter", argument: true },
      1: { name: "left-field", argument: true },
      2: { name: "right-field", argument: true },
      a: { name: "include-unpaired", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "delimiter" | "left-field" | "right-field" | "include-unpaired"
>;

const PATCH = {
  name: "patch",
  usage: "FILE [PATCHFILE]",
  summary: "applies a unified difference to a file",
} as const satisfies AppletSpec;

function checkedLines(text: string, maximumRecords: number, maximumLineBytes: number): string[] {
  const lines = splitLines(text);
  if (lines.length > maximumRecords) throw new VfsError("E2BIG", "buffered record limit exceeded");
  const encoder = new TextEncoder();
  for (const line of lines) {
    if (encoder.encode(line).byteLength > maximumLineBytes) {
      throw new VfsError("E2BIG", "line byte limit exceeded");
    }
  }
  return lines;
}

interface NumericSortKey {
  negative: boolean;
  integer: string;
  fraction: string;
}

const ZERO_NUMERIC_SORT_KEY: NumericSortKey = {
  negative: false,
  integer: "0",
  fraction: "",
};

function numericSortKey(value: string): NumericSortKey {
  const match = /^[ \t]*(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))/u.exec(value);
  if (match === null) return ZERO_NUMERIC_SORT_KEY;
  const integer = (match[2] ?? "").replace(/^0+/u, "") || "0";
  const fraction = (match[3] ?? match[4] ?? "").replace(/0+$/u, "");
  const zero = integer === "0" && fraction.length === 0;
  return { negative: match[1] === "-" && !zero, integer, fraction };
}

function compareNumericSortKeys(left: NumericSortKey, right: NumericSortKey): number {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  let order = left.integer.length - right.integer.length;
  if (order === 0 && left.integer !== right.integer) order = left.integer < right.integer ? -1 : 1;
  if (order === 0) {
    const length = Math.max(left.fraction.length, right.fraction.length);
    for (let index = 0; index < length; index += 1) {
      const first = left.fraction.charCodeAt(index) || 48;
      const second = right.fraction.charCodeAt(index) || 48;
      if (first !== second) {
        order = first - second;
        break;
      }
    }
  }
  return left.negative ? -order : order;
}

export const sortCommand = /* @__PURE__ */ defineApplet(SORT, async (context, argv, fds) => {
  const parsed = parseAppletOptions(SORT, argv);
  const reverse = parsed.options.some((option) => option.name === "reverse");
  const unique = parsed.options.some((option) => option.name === "unique");
  const numeric = parsed.options.some((option) => option.name === "numeric");
  const collected = await inputTexts(context, parsed.operands, fds[0]);
  try {
    const lines = checkedLines(
      collected.value.map((input) => input.text).join(""),
      context.budget.limits.maxBufferedRecords,
      context.budget.limits.maxLineBytes,
    );
    let records = lines.map((line) => {
      const value = line.endsWith("\n") ? line.slice(0, -1) : line;
      return { value, ...(numeric ? { numericKey: numericSortKey(value) } : {}) };
    });
    const compareKeys = (
      left: (typeof records)[number],
      right: (typeof records)[number],
    ): number =>
      numeric
        ? compareNumericSortKeys(
            left.numericKey ?? ZERO_NUMERIC_SORT_KEY,
            right.numericKey ?? ZERO_NUMERIC_SORT_KEY,
          )
        : compareUtf8(left.value, right.value);
    records.sort((left, right) => {
      let order = compareKeys(left, right);
      if (order === 0) order = compareUtf8(left.value, right.value);
      return reverse ? -order : order;
    });
    if (unique) {
      records = records.filter(
        (record, index) => index === 0 || compareKeys(record, records[index - 1] ?? record) !== 0,
      );
    }
    await writeText(fds[1], records.map((record) => `${record.value}\n`).join(""));
    return 0;
  } finally {
    collected.release();
  }
});

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

const C_WHITESPACE = " \t\n\v\f\r";

/**
 * Prints records matching a pattern.
 *
 * The pattern is a POSIX basic regular expression, or an extended one under
 * `-E`. It is translated rather than handed to the JavaScript engine, so no
 * JavaScript-only construct can mean something here that it does not mean in
 * `grep`. `-r` walks a directory operand through the paged traversal, so a
 * large subtree costs a bounded number of indexed queries and charges the
 * shared glob budget. `-q` stops at the first match without producing output,
 * which is what a guard wants.
 */
export const grepCommand = /* @__PURE__ */ defineApplet(GREP, async (context, argv, fds) => {
  const parsed = parseAppletOptions(GREP, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const ignoreCase = has("ignore-case");
  const invert = has("invert");
  const lineNumbers = has("line-numbers");
  const fixed = has("fixed");
  const extended = has("extended");
  const count = has("count");
  const filesWithMatches = has("files-with-matches");
  const quiet = has("quiet");
  const recursive = has("recursive");
  const noFilename = has("no-filename");
  if (fixed && extended) throw appletUsageError(GREP, "specify at most one of -F and -E");
  const values = [...parsed.operands];
  const pattern = values.shift();
  if (pattern === undefined) throw appletUsageError(GREP, "missing pattern");
  if (new TextEncoder().encode(pattern).byteLength > 4096) {
    throw new VfsError("E2BIG", "grep pattern is too large");
  }
  const regular = fixed
    ? undefined
    : compilePosixRegex(pattern, extended ? "extended" : "basic", GREP.name, {
        ...(ignoreCase ? { ignoreCase: true } : {}),
      });
  const needle = ignoreCase ? asciiLower(pattern) : pattern;

  const sources = recursive
    ? recursiveInputs(context, values)
    : contentInputs(context, values, fds[0]);
  // The name is shown when more than one file can be searched. Under `-r` that
  // means a directory operand — `grep -r pattern one.txt` prints bare lines,
  // exactly as the non-recursive form does.
  const expands = (path: string): boolean => {
    try {
      return context.fileSystem.stat(commandPath(context, path)).kind === "directory";
    } catch {
      return false;
    }
  };
  const showName =
    !noFilename &&
    (values.length > 1 || (recursive && (values.length === 0 || values.some(expands))));
  let matches = 0;
  let failed = false;
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of sources) {
      if (input.stream === undefined) {
        // One unreadable file is that file's failure. Reporting it and going on
        // keeps the matches already found, which is what `grep -r` does.
        await writeText(fds[2], `grep: ${input.name}: ${input.error.message}\n`);
        failed = true;
        continue;
      }
      let inputMatches = 0;
      let index = 0;
      for await (const line of readTextLines(context, input.stream, input.name)) {
        index += 1;
        const candidate = line.endsWith("\n") ? line.slice(0, -1) : line;
        const found = fixed
          ? (ignoreCase ? asciiLower(candidate) : candidate).includes(needle)
          : (regular?.test(candidate) ?? false);
        if (found === invert) continue;
        matches += 1;
        inputMatches += 1;
        if (quiet || filesWithMatches) break;
        if (count) continue;
        const prefix = `${showName ? `${input.name}:` : ""}${lineNumbers ? `${index}:` : ""}`;
        await output.write(`${prefix}${line}${line.endsWith("\n") ? "" : "\n"}`);
      }
      if (quiet && matches > 0) break;
      if (filesWithMatches) {
        if (inputMatches > 0) await output.write(`${input.name}\n`);
      } else if (count) {
        await output.write(`${showName ? `${input.name}:` : ""}${inputMatches}\n`);
      }
    }
    if (!quiet) await output.flush();
  } finally {
    output.abort();
  }
  // `grep` reserves 2 for "something went wrong", so a caller can tell an
  // unreadable file apart from a file with no matches.
  if (failed && !quiet) return 2;
  return matches > 0 ? 0 : 1;
});

function sliceCount(
  spec: AppletSpecWithOptions<"lines" | "bytes">,
  argv: readonly string[],
  defaultCount: number,
): {
  count: number;
  bytes: boolean;
  paths: readonly string[];
} {
  const parsed = parseAppletOptions(spec, argv);
  let count = defaultCount;
  let bytes = false;
  for (const option of parsed.options) {
    if (option.name === "lines" && "argument" in option) {
      bytes = false;
      count = parseInteger(option.argument, `${spec.name}: line count`);
    } else if (option.name === "bytes" && "argument" in option) {
      bytes = true;
      count = parseInteger(option.argument, `${spec.name}: byte count`);
    }
  }
  return { count, bytes, paths: parsed.operands };
}

export const headCommand = /* @__PURE__ */ defineApplet(HEAD, async (context, argv, fds) => {
  const options = sliceCount(HEAD, argv, 10);
  const headBytes = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    let remaining = options.count;
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
        await writeBytes(fds[1], output);
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
  };
  const headLines = async (stream: ReadableStream<Uint8Array>, path: string): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let remaining = options.count;
    let currentLineBytes = 0;
    let records = 0;
    let finished = false;
    const account = (bytes: Uint8Array): void => {
      for (const byte of bytes) {
        currentLineBytes += 1;
        if (currentLineBytes > context.budget.limits.maxLineBytes) {
          throw new VfsError("E2BIG", "line byte limit exceeded", path);
        }
        if (byte !== 0x0a) continue;
        currentLineBytes = 0;
        records += 1;
        context.budget.step();
        if (records > context.budget.limits.maxBufferedRecords) {
          throw new VfsError("E2BIG", "input record limit exceeded", path);
        }
      }
    };
    try {
      while (remaining > 0) {
        const result = await readWithAbort(reader, context.signal);
        if (result.done) {
          let finalText: string;
          try {
            finalText = decoder.decode();
          } catch {
            throw new VfsError("EIO", "input is not valid UTF-8", path);
          }
          if (currentLineBytes > 0) {
            records += 1;
            context.budget.step();
            if (records > context.budget.limits.maxBufferedRecords) {
              throw new VfsError("E2BIG", "input record limit exceeded", path);
            }
          }
          await writeText(fds[1], finalText);
          finished = true;
          break;
        }
        context.budget.io(result.value.byteLength);
        let end = result.value.byteLength;
        for (let index = 0; index < result.value.byteLength; index += 1) {
          if (result.value[index] === 0x0a && --remaining === 0) {
            end = index + 1;
            break;
          }
        }
        const bytes = result.value.slice(0, end);
        let text: string;
        try {
          text = decoder.decode(bytes, { stream: remaining > 0 });
        } catch {
          throw new VfsError("EIO", "input is not valid UTF-8", path);
        }
        account(bytes);
        await writeText(fds[1], text);
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
  };
  // `head -c N` needs only the first N bytes, and a store that can serve a
  // range should not be asked to send more. The request is advisory: a body
  // that arrives whole is still truncated below, so a store that ignores
  // ranges gives the same answer for more bytes.
  const wanted: ByteRange | undefined =
    options.bytes && options.count > 0 ? { offset: 0, length: options.count } : undefined;
  for await (const input of contentInputs(context, options.paths, fds[0], wanted)) {
    if (options.bytes) {
      await headBytes(input.stream);
      continue;
    }
    if (options.count === 0) {
      await input.stream.cancel(new VfsError("EPIPE", "head reached its line limit"));
      continue;
    }
    await headLines(input.stream, input.name);
  }
  return 0;
});

export const tailCommand = /* @__PURE__ */ defineApplet(TAIL, async (context, argv, fds) => {
  const options = sliceCount(TAIL, argv, 10);
  if (options.bytes) {
    for await (const input of inputStreams(context, options.paths, fds[0])) {
      const collected = await collectStream(context, input.stream);
      try {
        await writeBytes(
          fds[1],
          collected.value.slice(Math.max(0, collected.value.byteLength - options.count)),
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
      const lines = splitLines(input.text);
      await writeText(fds[1], lines.slice(Math.max(0, lines.length - options.count)).join(""));
    }
    return 0;
  } finally {
    collected.release();
  }
});

export const wcCommand = /* @__PURE__ */ defineApplet(WC, async (context, argv, fds) => {
  const parsed = parseAppletOptions(WC, argv);
  const linesOnly = parsed.options.some((option) => option.name === "lines");
  const wordsOnly = parsed.options.some((option) => option.name === "words");
  const bytesOnly = parsed.options.some((option) => option.name === "bytes");
  for await (const input of contentInputs(context, parsed.operands, fds[0])) {
    const reader = input.stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let lineCount = 0;
    let wordCount = 0;
    let byteCount = 0;
    let inWord = false;
    const needsWords = wordsOnly || (!linesOnly && !wordsOnly && !bytesOnly);
    const needsText = linesOnly || needsWords;
    const accountText = (text: string): void => {
      for (const character of text) {
        if (C_WHITESPACE.includes(character)) inWord = false;
        else if (!inWord) {
          wordCount += 1;
          inWord = true;
        }
      }
    };
    try {
      while (true) {
        const read = await readWithAbort(reader, context.signal);
        if (read.done) break;
        context.budget.io(read.value.byteLength);
        byteCount += read.value.byteLength;
        for (const byte of read.value) if (byte === 0x0a) lineCount += 1;
        if (needsText) {
          try {
            const text = decoder.decode(read.value, { stream: true });
            if (needsWords) accountText(text);
          } catch {
            throw new VfsError("EIO", "input is not valid UTF-8", input.name);
          }
        }
      }
      if (needsText) {
        try {
          const text = decoder.decode();
          if (needsWords) accountText(text);
        } catch {
          throw new VfsError("EIO", "input is not valid UTF-8", input.name);
        }
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const fields =
      linesOnly || wordsOnly || bytesOnly
        ? [
            linesOnly ? lineCount : undefined,
            wordsOnly ? wordCount : undefined,
            bytesOnly ? byteCount : undefined,
          ].filter((value) => value !== undefined)
        : [lineCount, wordCount, byteCount];
    await writeText(fds[1], `${fields.join(" ")}${input.name === "-" ? "" : ` ${input.name}`}\n`);
  }
  return 0;
});

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

export const cutCommand = /* @__PURE__ */ defineApplet(CUT, async (context, argv, fds) => {
  const parsed = parseAppletOptions(CUT, argv);
  let delimiter = "\t";
  let fields: number[] | undefined;
  let characters: number[] | undefined;
  for (const option of parsed.options) {
    if (!("argument" in option)) continue;
    if (option.name === "delimiter") delimiter = option.argument;
    else if (option.name === "fields") {
      fields = option.argument
        .split(",")
        .map((part) => parseInteger(part, `${CUT.name}: field`, 1));
    } else if (option.name === "characters") {
      characters = option.argument
        .split(",")
        .map((part) => parseInteger(part, `${CUT.name}: character`, 1));
    }
  }
  if ((fields === undefined) === (characters === undefined)) {
    throw appletUsageError(CUT, "specify exactly one of -f or -c");
  }
  if ([...delimiter].length !== 1) {
    throw appletUsageError(CUT, "delimiter must be exactly one character");
  }
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputStreams(context, parsed.operands, fds[0])) {
      for await (const line of readTextLines(context, input.stream, input.name)) {
        const newline = line.endsWith("\n") ? "\n" : "";
        const content = newline ? line.slice(0, -1) : line;
        await output.write(
          fields === undefined
            ? [...content].filter((_character, index) => characters?.includes(index + 1)).join("") +
                newline
            : (content.includes(delimiter)
                ? content
                    .split(delimiter)
                    .filter((_field, index) => fields?.includes(index + 1))
                    .join(delimiter)
                : content) + newline,
        );
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

function characterSet(value: string): string[] {
  const match = /^(.?)-(.?)$/u.exec(value);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const start = match[1].codePointAt(0) ?? 0;
    const end = match[2].codePointAt(0) ?? 0;
    return Array.from({ length: Math.max(0, end - start + 1) }, (_unused, index) =>
      String.fromCodePoint(start + index),
    );
  }
  return [...value];
}

export const trCommand = /* @__PURE__ */ defineApplet(TR, async (context, argv, fds) => {
  if (argv.length !== 2) throw appletUsageError(TR, "requires SET1 and SET2");
  const from = characterSet(argv[0] ?? "");
  const to = characterSet(argv[1] ?? "");
  const reader = fds[0].getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output = new BufferedTextWriter(context, fds[1]);
  const translate = (input: string): string =>
    [...input]
      .map((character) => {
        const index = from.indexOf(character);
        return index < 0 ? character : (to[Math.min(index, to.length - 1)] ?? "");
      })
      .join("");
  try {
    while (true) {
      const read = await readWithAbort(reader, context.signal);
      if (read.done) break;
      context.budget.io(read.value.byteLength);
      try {
        await output.write(translate(decoder.decode(read.value, { stream: true })));
      } catch (error) {
        if (error instanceof TypeError) throw new VfsError("EIO", "input is not valid UTF-8");
        throw error;
      }
    }
    try {
      await output.write(translate(decoder.decode()));
    } catch (error) {
      if (error instanceof TypeError) throw new VfsError("EIO", "input is not valid UTF-8");
      throw error;
    }
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
        const content = line.endsWith("\n") ? line.slice(0, -1) : line;
        if (content.length === 0) {
          await output.write(`       ${line.endsWith("\n") ? "\n" : ""}`);
        } else {
          await output.write(`${String(lineNumber++).padStart(6)}\t${line}`);
        }
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

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
        const newline = line.endsWith("\n");
        const characters = [...(newline ? line.slice(0, -1) : line)];
        while (characters.length > width) {
          await output.write(`${characters.splice(0, width).join("")}\n`);
        }
        await output.write(`${characters.join("")}${newline ? "\n" : ""}`);
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
      const stat = context.fileSystem.stat(commandPath(context, path));
      if (stat.kind !== "file") throw new VfsError("EISDIR", "is a directory", stat.path);
      if (stat.contentClass === "opaque") {
        if (stat.verifiedSha256 === undefined) {
          throw new VfsError("ENOTSUP", "opaque digest is not verified", stat.path);
        }
        await writeText(fds[1], `${stat.verifiedSha256}  ${path}\n`);
        continue;
      }
      const input = await readFileBytes(context, path);
      try {
        const digestInput = Uint8Array.from(input.value).buffer;
        const digest = await crypto.subtle.digest("SHA-256", digestInput);
        const hex = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        await writeText(fds[1], `${hex}  ${path}\n`);
      } finally {
        input.release();
      }
    }
    return 0;
  },
);

function requireSorted(lines: readonly string[], name: string): void {
  for (let index = 1; index < lines.length; index += 1) {
    if (compareUtf8(lines[index - 1] ?? "", lines[index] ?? "") > 0) {
      throw appletUsageError(COMM, `${name} is not sorted`);
    }
  }
}

export const commCommand = /* @__PURE__ */ defineApplet(COMM, async (context, argv, fds) => {
  const parsed = parseAppletOptions(COMM, argv);
  const suppressLeft = parsed.options.some((option) => option.name === "suppress-left");
  const suppressRight = parsed.options.some((option) => option.name === "suppress-right");
  const suppressCommon = parsed.options.some((option) => option.name === "suppress-common");
  const checkOrder = !parsed.options.some((option) => option.name === "no-check-order");
  const paths = parsed.operands;
  if (paths.length !== 2) throw appletUsageError(COMM, "requires two files");
  const collected = await inputTexts(context, paths, fds[0]);
  try {
    const inputs = collected.value;
    const left = checkedLines(
      inputs[0]?.text ?? "",
      context.budget.limits.maxBufferedRecords,
      context.budget.limits.maxLineBytes,
    ).map((line) => line.replace(/\n$/u, ""));
    const right = checkedLines(
      inputs[1]?.text ?? "",
      context.budget.limits.maxBufferedRecords,
      context.budget.limits.maxLineBytes,
    ).map((line) => line.replace(/\n$/u, ""));
    if (checkOrder) {
      requireSorted(left, paths[0] ?? "left input");
      requireSorted(right, paths[1] ?? "right input");
    }
    const visible = [!suppressLeft, !suppressRight, !suppressCommon];
    let leftIndex = 0;
    let rightIndex = 0;
    const output = new BufferedTextWriter(context, fds[1]);
    try {
      while (leftIndex < left.length || rightIndex < right.length) {
        const leftLine = left[leftIndex];
        const rightLine = right[rightIndex];
        let column: 0 | 1 | 2;
        let line: string;
        if (leftLine !== undefined && leftLine === rightLine) {
          column = 2;
          line = leftLine;
          leftIndex += 1;
          rightIndex += 1;
        } else if (
          rightLine === undefined ||
          (leftLine !== undefined && compareUtf8(leftLine, rightLine) < 0)
        ) {
          column = 0;
          line = leftLine ?? "";
          leftIndex += 1;
        } else {
          column = 1;
          line = rightLine;
          rightIndex += 1;
        }
        if (visible[column]) {
          const prefix = visible.slice(0, column).filter(Boolean).length;
          await output.write(`${"\t".repeat(prefix)}${line}\n`);
        }
      }
      await output.flush();
    } finally {
      output.abort();
    }
    return 0;
  } finally {
    collected.release();
  }
});

interface JoinLine {
  fields: string[];
  key: string;
  text: string;
}

export const joinCommand = /* @__PURE__ */ defineApplet(JOIN, async (context, argv, fds) => {
  const parsed = parseAppletOptions(JOIN, argv);
  let delimiter = " ";
  let leftField = 1;
  let rightField = 1;
  const includeUnpaired = new Set<1 | 2>();
  for (const option of parsed.options) {
    if (!("argument" in option)) continue;
    if (option.name === "delimiter") delimiter = option.argument;
    else if (option.name === "left-field") {
      leftField = parseInteger(option.argument, `${JOIN.name}: -1 field`, 1);
    } else if (option.name === "right-field") {
      rightField = parseInteger(option.argument, `${JOIN.name}: -2 field`, 1);
    } else if (option.name === "include-unpaired") {
      const side = parseInteger(option.argument, `${JOIN.name}: -a file`, 1);
      if (side !== 1 && side !== 2) throw appletUsageError(JOIN, "-a must be 1 or 2");
      includeUnpaired.add(side);
    }
  }
  const paths = parsed.operands;
  if (delimiter.length !== 1) throw appletUsageError(JOIN, "delimiter must be one character");
  if (paths.length !== 2) throw appletUsageError(JOIN, "requires two files");
  const collected = await inputTexts(context, paths, fds[0]);
  try {
    const inputs = collected.value;
    const parse = (text: string, field: number, file: 1 | 2): JoinLine[] => {
      const lines = checkedLines(
        text,
        context.budget.limits.maxBufferedRecords,
        context.budget.limits.maxLineBytes,
      ).map((line, index) => {
        const value = line.replace(/\n$/u, "");
        const fields = delimiter === " " ? value.trim().split(/[ \t]+/u) : value.split(delimiter);
        const key = fields[field - 1];
        if (key === undefined) {
          throw appletUsageError(JOIN, `file ${file} line ${index + 1} lacks field ${field}`);
        }
        return { fields, key, text: value };
      });
      for (let index = 1; index < lines.length; index += 1) {
        if (compareUtf8(lines[index - 1]?.key ?? "", lines[index]?.key ?? "") > 0) {
          throw appletUsageError(JOIN, `${paths[file - 1] ?? `file ${file}`} is not sorted`);
        }
      }
      return lines;
    };
    const left = parse(inputs[0]?.text ?? "", leftField, 1);
    const right = parse(inputs[1]?.text ?? "", rightField, 2);
    let rows = 0;
    const output = new BufferedTextWriter(context, fds[1]);
    const emit = async (line: string): Promise<void> => {
      rows += 1;
      if (rows > context.budget.limits.maxBufferedRecords) {
        throw new VfsError("E2BIG", "join output record limit exceeded");
      }
      await output.write(`${line}\n`);
    };
    try {
      let leftIndex = 0;
      let rightIndex = 0;
      while (leftIndex < left.length || rightIndex < right.length) {
        const leftLine = left[leftIndex];
        const rightLine = right[rightIndex];
        const order =
          leftLine === undefined
            ? 1
            : rightLine === undefined
              ? -1
              : compareUtf8(leftLine.key, rightLine.key);
        if (order < 0) {
          if (includeUnpaired.has(1)) await emit(leftLine?.text ?? "");
          leftIndex += 1;
          continue;
        }
        if (order > 0) {
          if (includeUnpaired.has(2)) await emit(rightLine?.text ?? "");
          rightIndex += 1;
          continue;
        }

        const key = leftLine?.key ?? "";
        let leftEnd = leftIndex;
        while (left[leftEnd]?.key === key) leftEnd += 1;
        let rightEnd = rightIndex;
        while (right[rightEnd]?.key === key) rightEnd += 1;
        for (let leftMatch = leftIndex; leftMatch < leftEnd; leftMatch += 1) {
          for (let rightMatch = rightIndex; rightMatch < rightEnd; rightMatch += 1) {
            const leftRecord = left[leftMatch];
            const rightRecord = right[rightMatch];
            if (leftRecord === undefined || rightRecord === undefined) continue;
            await emit(
              [
                key,
                ...leftRecord.fields.filter((_field, index) => index !== leftField - 1),
                ...rightRecord.fields.filter((_field, index) => index !== rightField - 1),
              ].join(delimiter),
            );
          }
        }
        leftIndex = leftEnd;
        rightIndex = rightEnd;
      }
      await output.flush();
    } finally {
      output.abort();
    }
    return 0;
  } finally {
    collected.release();
  }
});

export const patchCommand = /* @__PURE__ */ defineApplet(PATCH, async (context, argv, fds) => {
  if (argv.length < 1 || argv.length > 2) {
    throw appletUsageError(PATCH, "usage: patch FILE [PATCHFILE]");
  }
  const path = commandPath(context, argv[0]);
  const token = context.fileSystem.getMutationToken(path);
  const current = context.fileSystem.readFile(path);
  const source = await collectText(context, current.stream, path);
  try {
    const patch =
      argv[1] === undefined
        ? await collectText(context, fds[0])
        : await readFileText(context, argv[1]);
    try {
      const applied = applyUnifiedPatch(source.value, patch.value);
      await context.fileSystem.writeFile(path, applied.text, {
        ifMutationToken: token,
        disposition: "replace",
        mode: current.stat.mode,
      });
      return 0;
    } finally {
      patch.release();
    }
  } finally {
    source.release();
  }
});

const SEQ = {
  name: "seq",
  usage: "[-s SEPARATOR] [-w] [FIRST [INCREMENT]] LAST",
  summary: "prints an integer sequence",
  options: {
    short: {
      s: { name: "separator", argument: true },
      w: { name: "equal-width" },
    },
    negativeNumberOperands: true,
  },
} as const satisfies AppletSpecWithOptions<"separator" | "equal-width">;

function seqOperand(value: string, name: string): number {
  if (!/^-?[0-9]+$/u.test(value)) {
    throw appletUsageError(SEQ, `${name} must be a decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw appletUsageError(SEQ, `${name} exceeds the safe integer range`);
  }
  return parsed;
}

/**
 * Prints an integer sequence. Operands are strict decimal integers rather than
 * Bash arithmetic or floating point, matching the project's deterministic
 * integer profile; the produced count charges the shared expansion budget.
 */
export const seqCommand = /* @__PURE__ */ defineApplet(SEQ, async (context, argv, fds) => {
  const parsed = parseAppletOptions(SEQ, argv);
  let separator = "\n";
  let equalWidth = false;
  for (const option of parsed.options) {
    if (option.name === "separator" && "argument" in option) separator = option.argument;
    if (option.name === "equal-width") equalWidth = true;
  }
  if (parsed.operands.length === 0 || parsed.operands.length > 3) {
    throw appletUsageError(SEQ, "requires one to three integer operands");
  }
  const [one = "", two, three] = parsed.operands;
  const first = two === undefined ? 1 : seqOperand(one, "FIRST");
  const increment = three === undefined ? 1 : seqOperand(two ?? "", "INCREMENT");
  const last = seqOperand(three ?? two ?? one, "LAST");
  if (increment === 0) throw appletUsageError(SEQ, "INCREMENT must not be zero");

  const values: number[] = [];
  for (let value = first; increment > 0 ? value <= last : value >= last; value += increment) {
    context.budget.step();
    context.budget.expansionOutput(String(value).length, 1);
    values.push(value);
  }
  const width = equalWidth ? Math.max(0, ...values.map((value) => String(value).length)) : 0;
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    // The separator joins values; the sequence always ends with one newline,
    // so the default separator produces one record per value.
    for (const [index, value] of values.entries()) {
      await output.write(`${index === 0 ? "" : separator}${String(value).padStart(width, "0")}`);
    }
    if (values.length > 0) await output.write("\n");
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

const BASE64 = {
  name: "base64",
  usage: "[-d] [-w COLUMNS] [FILE]",
  summary: "encodes or decodes standard base64",
  options: {
    short: {
      d: { name: "decode" },
      w: { name: "wrap", argument: true },
    },
    long: {
      decode: { name: "decode" },
      wrap: { name: "wrap", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<"decode" | "wrap">;

/** Encodes or decodes standard base64. Decoding rejects invalid input. */
export const base64Command = /* @__PURE__ */ defineApplet(BASE64, async (context, argv, fds) => {
  const parsed = parseAppletOptions(BASE64, argv);
  let decode = false;
  let wrap = 76;
  for (const option of parsed.options) {
    if (option.name === "decode") decode = true;
    if (option.name === "wrap" && "argument" in option) {
      wrap = parseInteger(option.argument, `${BASE64.name}: -w`, 0);
    }
  }
  if (parsed.operands.length > 1) throw appletUsageError(BASE64, "accepts at most one file");

  const [path] = parsed.operands;
  if (decode) {
    const input =
      path === undefined || path === "-"
        ? await collectText(context, fds[0])
        : await readFileText(context, path);
    try {
      const compact = input.value.replace(/[\n\r]/gu, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) {
        throw appletUsageError(BASE64, "invalid input");
      }
      const binary = atob(compact);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      await writeBytes(fds[1], bytes);
      return 0;
    } finally {
      input.release();
    }
  }

  const input =
    path === undefined || path === "-"
      ? await collectStream(context, fds[0])
      : await readFileBytes(context, path);
  try {
    let binary = "";
    for (const byte of input.value) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    // `-w 0` disables wrapping entirely, including the trailing newline.
    if (wrap === 0) {
      await writeText(fds[1], encoded);
      return 0;
    }
    const output = new BufferedTextWriter(context, fds[1]);
    try {
      for (let index = 0; index < encoded.length; index += wrap) {
        await output.write(`${encoded.slice(index, index + wrap)}\n`);
      }
      await output.flush();
    } finally {
      output.abort();
    }
    return 0;
  } finally {
    input.release();
  }
});
