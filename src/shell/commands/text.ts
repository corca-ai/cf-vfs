import { VfsError } from "../../core/errors.js";
import { createLineDiff, renderLineDiff } from "../../core/line-diff.js";
import { compareUtf8 } from "../../core/path.js";
import { applyUnifiedPatch } from "../../core/unified-patch.js";
import { BufferedTextWriter, commandPath, collectStream, collectText, defineCommand, inputStreams, inputTexts, parseInteger, readFileBytes, readFileText, readTextLines, readWithAbort, splitLines, writeBytes, writeText } from "./helpers.js";
import { parseUtilityOptions } from "./options.js";

const SORT_OPTIONS = {
  short: {
    r: { name: "reverse" },
    u: { name: "unique" },
    n: { name: "numeric" },
  },
} as const;

const GREP_OPTIONS = {
  short: {
    i: { name: "ignore-case" },
    v: { name: "invert" },
    n: { name: "line-numbers" },
    F: { name: "fixed" },
    c: { name: "count" },
  },
} as const;

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

const WC_OPTIONS = {
  short: {
    l: { name: "lines" },
    w: { name: "words" },
    c: { name: "bytes" },
  },
} as const;

const TEE_OPTIONS = {
  short: { a: { name: "append" } },
  long: { append: { name: "append" } },
} as const;

const UNIQ_OPTIONS = {
  short: { c: { name: "count" } },
} as const;

const CUT_OPTIONS = {
  short: {
    d: { name: "delimiter", argument: true },
    f: { name: "fields", argument: true },
    c: { name: "characters", argument: true },
  },
} as const;

const FOLD_OPTIONS = {
  short: { w: { name: "width", argument: true } },
} as const;

const COMM_OPTIONS = {
  short: {
    1: { name: "suppress-left" },
    2: { name: "suppress-right" },
    3: { name: "suppress-common" },
  },
  long: {
    "nocheck-order": { name: "no-check-order" },
  },
} as const;

const JOIN_OPTIONS = {
  short: {
    t: { name: "delimiter", argument: true },
    1: { name: "left-field", argument: true },
    2: { name: "right-field", argument: true },
    a: { name: "include-unpaired", argument: true },
  },
} as const;

function checkedLines(
  text: string,
  maximumRecords: number,
  maximumLineBytes: number,
): string[] {
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

export const sortCommand = /* @__PURE__ */ defineCommand("sort", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("sort", argv, SORT_OPTIONS);
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
    const compareKeys = (left: typeof records[number], right: typeof records[number]): number => numeric
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
      records = records.filter((record, index) =>
        index === 0 || compareKeys(record, records[index - 1] ?? record) !== 0);
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

function asciiCaseInsensitiveRegexSource(source: string): string {
  let output = "";
  for (let index = 0; index < source.length;) {
    const character = source[index] ?? "";
    if (character !== "\\") {
      if (source.startsWith("(?<", index) && !["=", "!"].includes(source[index + 3] ?? "")) {
        const end = source.indexOf(">", index + 3);
        if (end >= 0) {
          output += source.slice(index, end + 1);
          index = end + 1;
          continue;
        }
      }
      output += asciiLower(character);
      index += character.length;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) {
      output += character;
      break;
    }
    if ((escaped === "p" || escaped === "P") && source[index + 2] === "{") {
      const end = source.indexOf("}", index + 3);
      if (end >= 0) {
        output += source.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    if (escaped === "k" && source[index + 2] === "<") {
      const end = source.indexOf(">", index + 3);
      if (end >= 0) {
        output += source.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }

    const fixedHexDigits = escaped === "x" ? 2 : escaped === "u" ? 4 : 0;
    if (fixedHexDigits > 0) {
      const digits = source.slice(index + 2, index + 2 + fixedHexDigits);
      if (digits.length === fixedHexDigits && /^[0-9a-f]+$/iu.test(digits)) {
        const codePoint = Number.parseInt(digits, 16);
        const folded = codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 0x20 : codePoint;
        output += `\\${escaped}${folded.toString(16).padStart(fixedHexDigits, "0")}`;
        index += 2 + fixedHexDigits;
        continue;
      }
    }
    if (escaped === "u" && source[index + 2] === "{") {
      const end = source.indexOf("}", index + 3);
      const digits = end < 0 ? "" : source.slice(index + 3, end);
      if (end >= 0 && /^[0-9a-f]+$/iu.test(digits)) {
        const codePoint = Number.parseInt(digits, 16);
        const folded = codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 0x20 : codePoint;
        output += `\\u{${folded.toString(16)}}`;
        index = end + 1;
        continue;
      }
    }
    output += `\\${escaped}`;
    index += 2;
  }
  return output;
}

export const grepCommand = /* @__PURE__ */ defineCommand("grep", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("grep", argv, GREP_OPTIONS);
  const ignoreCase = parsed.options.some((option) => option.name === "ignore-case");
  const invert = parsed.options.some((option) => option.name === "invert");
  const lineNumbers = parsed.options.some((option) => option.name === "line-numbers");
  const fixed = parsed.options.some((option) => option.name === "fixed");
  const count = parsed.options.some((option) => option.name === "count");
  const values = [...parsed.operands];
  const pattern = values.shift();
  if (pattern === undefined) throw new VfsError("EINVAL", "grep: missing pattern");
  if (new TextEncoder().encode(pattern).byteLength > 4096) {
    throw new VfsError("E2BIG", "grep pattern is too large");
  }
  let regular: RegExp | undefined;
  if (!fixed) {
    try {
      regular = new RegExp(ignoreCase ? asciiCaseInsensitiveRegexSource(pattern) : pattern, "u");
    } catch {
      throw new VfsError("EINVAL", "grep: invalid regular expression");
    }
  }
  const multipleInputs = values.length > 1;
  let matches = 0;
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputStreams(context, values, fds[0])) {
      let inputMatches = 0;
      let index = 0;
      for await (const line of readTextLines(context, input.stream, input.name)) {
        index += 1;
      const candidate = line.endsWith("\n") ? line.slice(0, -1) : line;
      const found = fixed
        ? (ignoreCase ? asciiLower(candidate).includes(asciiLower(pattern)) : candidate.includes(pattern))
        : regular?.test(ignoreCase ? asciiLower(candidate) : candidate) ?? false;
      regular && (regular.lastIndex = 0);
      if (found === invert) continue;
      matches += 1;
        inputMatches += 1;
      if (!count) {
          const prefix = `${multipleInputs ? `${input.name}:` : ""}${lineNumbers ? `${index}:` : ""}`;
          await output.write(`${prefix}${line}${line.endsWith("\n") ? "" : "\n"}`);
        }
      }
      if (count) await output.write(`${multipleInputs ? `${input.name}:` : ""}${inputMatches}\n`);
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return matches > 0 ? 0 : 1;
});

function sliceCount(command: "head" | "tail", argv: readonly string[], defaultCount: number): {
  count: number;
  bytes: boolean;
  paths: readonly string[];
} {
  const parsed = parseUtilityOptions(command, argv, SLICE_OPTIONS);
  let count = defaultCount;
  let bytes = false;
  for (const option of parsed.options) {
    if (option.name === "lines" && "argument" in option) {
      bytes = false;
      count = parseInteger(option.argument, "line count");
    } else if (option.name === "bytes" && "argument" in option) {
      bytes = true;
      count = parseInteger(option.argument, "byte count");
    }
  }
  return { count, bytes, paths: parsed.operands };
}

export const headCommand = /* @__PURE__ */ defineCommand("head", async (context, argv, fds) => {
  const options = sliceCount("head", argv, 10);
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
        await reader.cancel(new VfsError("EPIPE", "head stopped reading input")).catch(() => undefined);
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
        await reader.cancel(new VfsError("EPIPE", "head stopped reading input")).catch(() => undefined);
      }
      reader.releaseLock();
    }
  };
  for await (const input of inputStreams(context, options.paths, fds[0])) {
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

export const tailCommand = /* @__PURE__ */ defineCommand("tail", async (context, argv, fds) => {
  const options = sliceCount("tail", argv, 10);
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

export const wcCommand = /* @__PURE__ */ defineCommand("wc", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("wc", argv, WC_OPTIONS);
  const linesOnly = parsed.options.some((option) => option.name === "lines");
  const wordsOnly = parsed.options.some((option) => option.name === "words");
  const bytesOnly = parsed.options.some((option) => option.name === "bytes");
  for await (const input of inputStreams(context, parsed.operands, fds[0])) {
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
    const fields = linesOnly || wordsOnly || bytesOnly
      ? [linesOnly ? lineCount : undefined, wordsOnly ? wordCount : undefined, bytesOnly ? byteCount : undefined]
        .filter((value) => value !== undefined)
      : [lineCount, wordCount, byteCount];
    await writeText(fds[1], `${fields.join(" ")}${input.name === "-" ? "" : ` ${input.name}`}\n`);
  }
  return 0;
});

export const teeCommand = /* @__PURE__ */ defineCommand("tee", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("tee", argv, TEE_OPTIONS);
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

export const uniqCommand = /* @__PURE__ */ defineCommand("uniq", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("uniq", argv, UNIQ_OPTIONS);
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

export const cutCommand = /* @__PURE__ */ defineCommand("cut", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("cut", argv, CUT_OPTIONS);
  let delimiter = "\t";
  let fields: number[] | undefined;
  let characters: number[] | undefined;
  for (const option of parsed.options) {
    if (!("argument" in option)) continue;
    if (option.name === "delimiter") delimiter = option.argument;
    else if (option.name === "fields") {
      fields = option.argument.split(",").map((part) => parseInteger(part, "field", 1));
    } else if (option.name === "characters") {
      characters = option.argument.split(",").map((part) => parseInteger(part, "character", 1));
    }
  }
  if ((fields === undefined) === (characters === undefined)) {
    throw new VfsError("EINVAL", "cut: specify exactly one of -f or -c");
  }
  if ([...delimiter].length !== 1) {
    throw new VfsError("EINVAL", "cut: delimiter must be exactly one character");
  }
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputStreams(context, parsed.operands, fds[0])) {
      for await (const line of readTextLines(context, input.stream, input.name)) {
        const newline = line.endsWith("\n") ? "\n" : "";
        const content = newline ? line.slice(0, -1) : line;
        await output.write(fields === undefined
          ? [...content].filter((_character, index) => characters?.includes(index + 1)).join("") + newline
          : (content.includes(delimiter)
            ? content.split(delimiter).filter((_field, index) => fields?.includes(index + 1)).join(delimiter)
            : content) + newline);
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
    return Array.from({ length: Math.max(0, end - start + 1) }, (_unused, index) => String.fromCodePoint(start + index));
  }
  return [...value];
}

export const trCommand = /* @__PURE__ */ defineCommand("tr", async (context, argv, fds) => {
  if (argv.length !== 2) throw new VfsError("EINVAL", "tr: requires SET1 and SET2");
  const from = characterSet(argv[0] ?? "");
  const to = characterSet(argv[1] ?? "");
  const reader = fds[0].getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output = new BufferedTextWriter(context, fds[1]);
  const translate = (input: string): string => [...input].map((character) => {
    const index = from.indexOf(character);
    return index < 0 ? character : to[Math.min(index, to.length - 1)] ?? "";
  }).join("");
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

export const nlCommand = /* @__PURE__ */ defineCommand("nl", async (context, argv, fds) => {
  for (const value of argv) {
    if (value.startsWith("-") && value !== "-") {
      throw new VfsError("EINVAL", `nl: unsupported option ${value}`);
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

export const foldCommand = /* @__PURE__ */ defineCommand("fold", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("fold", argv, FOLD_OPTIONS);
  let width = 80;
  for (const option of parsed.options) {
    if (option.name === "width" && "argument" in option) {
      width = parseInteger(option.argument, "width", 1);
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

export const pasteCommand = /* @__PURE__ */ defineCommand("paste", async (context, argv, fds) => {
  const inputs = await inputTexts(context, argv, fds[0]);
  try {
    const columns = inputs.value.map((input) =>
      splitLines(input.text).map((line) => line.replace(/\n$/u, "")));
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

export const cmpCommand = /* @__PURE__ */ defineCommand("cmp", async (context, argv, fds) => {
  if (argv.length !== 2) throw new VfsError("EINVAL", "cmp: requires two files");
  const left = await readFileBytes(context, argv[0] ?? "");
  let right;
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

export const diffCommand = /* @__PURE__ */ defineCommand("diff", async (context, argv, fds) => {
  if (argv.length !== 2) throw new VfsError("EINVAL", "diff: requires two files");
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

export const sha256sumCommand = /* @__PURE__ */ defineCommand("sha256sum", async (context, argv, fds) => {
  if (argv.length === 0) throw new VfsError("EINVAL", "sha256sum: missing operand");
  for (const path of argv) {
    const stat = await context.fileSystem.stat(commandPath(context, path));
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
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      await writeText(fds[1], `${hex}  ${path}\n`);
    } finally {
      input.release();
    }
  }
  return 0;
});

export const sedCommand = /* @__PURE__ */ defineCommand("sed", async (context, argv, fds) => {
  const expression = argv[0];
  if (expression === undefined) throw new VfsError("EINVAL", "sed: missing expression");
  const match = /^s(.)(.*?)\1(.*?)\1(g?)$/u.exec(expression);
  if (match === null) throw new VfsError("EINVAL", "sed: only s/old/new/[g] is supported");
  const [, , pattern = "", replacement = "", global = ""] = match;
  let regular: RegExp;
  try {
    regular = new RegExp(pattern, global === "g" ? "gu" : "u");
  } catch {
    throw new VfsError("EINVAL", "sed: invalid regular expression");
  }
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputStreams(context, argv.slice(1), fds[0])) {
      for await (const line of readTextLines(context, input.stream, input.name)) {
        regular.lastIndex = 0;
        await output.write(line.replace(regular, replacement));
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

function requireSorted(lines: readonly string[], name: string): void {
  for (let index = 1; index < lines.length; index += 1) {
    if (compareUtf8(lines[index - 1] ?? "", lines[index] ?? "") > 0) {
      throw new VfsError("EINVAL", `comm: ${name} is not sorted`);
    }
  }
}

export const commCommand = /* @__PURE__ */ defineCommand("comm", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("comm", argv, COMM_OPTIONS);
  const suppressLeft = parsed.options.some((option) => option.name === "suppress-left");
  const suppressRight = parsed.options.some((option) => option.name === "suppress-right");
  const suppressCommon = parsed.options.some((option) => option.name === "suppress-common");
  const checkOrder = !parsed.options.some((option) => option.name === "no-check-order");
  const paths = parsed.operands;
  if (paths.length !== 2) throw new VfsError("EINVAL", "comm: requires two files");
  const collected = await inputTexts(context, paths, fds[0]);
  try {
  const inputs = collected.value;
  const left = checkedLines(inputs[0]?.text ?? "", context.budget.limits.maxBufferedRecords, context.budget.limits.maxLineBytes)
    .map((line) => line.replace(/\n$/u, ""));
  const right = checkedLines(inputs[1]?.text ?? "", context.budget.limits.maxBufferedRecords, context.budget.limits.maxLineBytes)
    .map((line) => line.replace(/\n$/u, ""));
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

export const joinCommand = /* @__PURE__ */ defineCommand("join", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("join", argv, JOIN_OPTIONS);
  let delimiter = " ";
  let leftField = 1;
  let rightField = 1;
  const includeUnpaired = new Set<1 | 2>();
  for (const option of parsed.options) {
    if (!("argument" in option)) continue;
    if (option.name === "delimiter") delimiter = option.argument;
    else if (option.name === "left-field") {
      leftField = parseInteger(option.argument, "left join field", 1);
    } else if (option.name === "right-field") {
      rightField = parseInteger(option.argument, "right join field", 1);
    } else if (option.name === "include-unpaired") {
      const side = parseInteger(option.argument, "unpaired file", 1);
      if (side !== 1 && side !== 2) throw new VfsError("EINVAL", "join: -a must be 1 or 2");
      includeUnpaired.add(side);
    }
  }
  const paths = parsed.operands;
  if (delimiter.length !== 1) throw new VfsError("EINVAL", "join: delimiter must be one character");
  if (paths.length !== 2) throw new VfsError("EINVAL", "join: requires two files");
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
          throw new VfsError("EINVAL", `join: file ${file} line ${index + 1} lacks field ${field}`);
        }
        return { fields, key, text: value };
      });
      for (let index = 1; index < lines.length; index += 1) {
        if (compareUtf8(lines[index - 1]?.key ?? "", lines[index]?.key ?? "") > 0) {
          throw new VfsError("EINVAL", `join: ${paths[file - 1] ?? `file ${file}`} is not sorted`);
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
        const order = leftLine === undefined ? 1
          : rightLine === undefined ? -1
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
            await emit([
              key,
              ...leftRecord.fields.filter((_field, index) => index !== leftField - 1),
              ...rightRecord.fields.filter((_field, index) => index !== rightField - 1),
            ].join(delimiter));
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

export const patchCommand = /* @__PURE__ */ defineCommand("patch", async (context, argv, fds) => {
  if (argv.length < 1 || argv.length > 2) {
    throw new VfsError("EINVAL", "patch: usage: patch FILE [PATCHFILE]");
  }
  const path = commandPath(context, argv[0]);
  const token = await context.fileSystem.getMutationToken(path);
  const current = await context.fileSystem.readFile(path);
  const source = await collectText(context, current.stream, path);
  try {
    const patch = argv[1] === undefined
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
