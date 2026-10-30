import { sha256Hex } from "../../vfs/digest.js";
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
  collectStream,
  commandPath,
  parseInteger,
  readTextLines,
  writeBytes,
  writeText,
} from "./helpers.js";
import { inputSources } from "./inputs.js";
import type { ParsedUtilityOption } from "./options.js";

export { commCommand, joinCommand } from "./text-compare.js";
export { cmpCommand, diffCommand } from "./text-diff.js";
export { base64Command, patchCommand, seqCommand } from "./text-extra.js";
export { md5sumCommand } from "./text-md5.js";
export { odCommand } from "./text-od.js";
export { pasteCommand } from "./text-paste.js";
export { grepCommand } from "./text-search.js";
export { headCommand, tailCommand } from "./text-slice.js";
export { sortCommand } from "./text-sort.js";
export { trCommand } from "./text-tr.js";
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
  usage: "[-cdiu] [-f N] [-s N] [-w N] [FILE...]",
  summary: "collapses adjacent duplicate records",
  options: {
    short: {
      c: { name: "count" },
      d: { name: "repeated" },
      u: { name: "unique" },
      i: { name: "ignore-case" },
      f: { name: "skip-fields", argument: true },
      s: { name: "skip-chars", argument: true },
      w: { name: "check-chars", argument: true },
    },
    long: {
      count: { name: "count" },
      repeated: { name: "repeated" },
      unique: { name: "unique" },
      "ignore-case": { name: "ignore-case" },
      "skip-fields": { name: "skip-fields", argument: true },
      "skip-chars": { name: "skip-chars", argument: true },
      "check-chars": { name: "check-chars", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "count" | "repeated" | "unique" | "ignore-case" | "skip-fields" | "skip-chars" | "check-chars"
>;

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

const SHA256SUM = {
  name: "sha256sum",
  usage: "[FILE...]",
  summary: "prints the SHA-256 digest of each file or of standard input",
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

interface UniqKey {
  readonly skipFields: number;
  readonly skipChars: number;
  readonly checkChars: number | undefined;
  readonly ignoreCase: boolean;
}

/** The part GNU compares: after `-f` blank-separated fields and `-s` characters, `-w` long. */
function uniqKey(value: string, key: UniqKey): string {
  let index = 0;
  for (let field = 0; field < key.skipFields; field += 1) {
    while (value[index] === " " || value[index] === "\t") index += 1;
    while (index < value.length && value[index] !== " " && value[index] !== "\t") index += 1;
  }
  const characters = [...value.slice(index)].slice(key.skipChars);
  const checked = key.checkChars === undefined ? characters : characters.slice(0, key.checkChars);
  const text = checked.join("");
  return key.ignoreCase ? text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()) : text;
}

function uniqCount(
  parsed: ReturnType<typeof parseAppletOptions<string>>,
  name: string,
): number | undefined {
  const option = parsed.options.filter((candidate) => candidate.name === name).at(-1);
  if (option === undefined || !("argument" in option)) return undefined;
  return parseInteger(option.argument, `${UNIQ.name}: ${name}`);
}

export const uniqCommand = /* @__PURE__ */ defineApplet(UNIQ, async (context, argv, fds) => {
  const parsed = parseAppletOptions(UNIQ, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const count = has("count");
  const repeated = has("repeated");
  const unique = has("unique");
  const key: UniqKey = {
    skipFields: uniqCount(parsed, "skip-fields") ?? 0,
    skipChars: uniqCount(parsed, "skip-chars") ?? 0,
    checkChars: uniqCount(parsed, "check-chars"),
    ignoreCase: has("ignore-case"),
  };
  const output = new BufferedTextWriter(context, fds[1]);
  let previous: { value: string; key: string } | undefined;
  let repeats = 0;
  const emit = async (): Promise<void> => {
    if (previous === undefined) return;
    if ((repeated && repeats < 2) || (unique && repeats > 1)) return;
    await output.write(`${count ? `${String(repeats).padStart(7)} ` : ""}${previous.value}\n`);
  };
  try {
    for await (const input of inputSources(context, parsed.operands, fds[0])) {
      for await (const line of readTextLines(context, input.source, input.name)) {
        const value = line.endsWith("\n") ? line.slice(0, -1) : line;
        const current = uniqKey(value, key);
        // A group keeps its first record, as GNU prints it.
        if (previous !== undefined && previous.key === current) {
          repeats += 1;
          continue;
        }
        await emit();
        previous = { value, key: current };
        repeats = 1;
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
    for await (const input of inputSources(context, invocation.operands, fds[0])) {
      for await (const line of readTextLines(context, input.source, input.name)) {
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

export const nlCommand = /* @__PURE__ */ defineApplet(NL, async (context, argv, fds) => {
  for (const value of argv) {
    if (value.startsWith("-") && value !== "-") {
      throw appletUsageError(NL, `unsupported option ${value}`);
    }
  }
  let lineNumber = 1;
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for await (const input of inputSources(context, argv, fds[0])) {
      for await (const line of readTextLines(context, input.source, input.name)) {
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
    for await (const input of inputSources(context, parsed.operands, fds[0])) {
      for await (const line of readTextLines(context, input.source, input.name)) {
        await writeFoldedLine(output, line, width);
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

async function standardInputDigest(
  context: ShellCommandContext,
  stdin: ReadableStream<Uint8Array>,
): Promise<string> {
  const input = await collectStream(context, stdin);
  try {
    return await sha256Hex([input.value], input.value.byteLength);
  } finally {
    input.release();
  }
}

export const sha256sumCommand = /* @__PURE__ */ defineApplet(
  SHA256SUM,
  async (context, argv, fds) => {
    for (const path of argv.length === 0 ? ["-"] : argv) {
      // Standard input has no stored digest, so it is hashed as it is read.
      const digest =
        path === "-"
          ? await standardInputDigest(context, fds[0])
          : await context.fileSystem.digestFile(commandPath(context, path));
      await writeText(fds[1], `${digest}  ${path}\n`);
    }
    return 0;
  },
);
