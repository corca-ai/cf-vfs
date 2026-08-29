import { applyUnifiedPatch } from "../../core/unified-patch.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
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
  collectText,
  commandPath,
  parseInteger,
  readFileBytes,
  readFileText,
  writeBytes,
  writeText,
} from "./helpers.js";

const PATCH = {
  name: "patch",
  usage: "FILE [PATCHFILE]",
  summary: "applies a unified difference to a file",
} as const satisfies AppletSpec;

export const patchCommand = /* @__PURE__ */ defineApplet(PATCH, async (context, argv, fds) => {
  if (argv.length < 1 || argv.length > 2) {
    throw appletUsageError(PATCH, "usage: patch FILE [PATCHFILE]");
  }
  const path = commandPath(context, argv[0]);
  const current = context.fileSystem.readFile(path);
  const token =
    current.stat.path === path
      ? current.stat.mutationToken
      : context.fileSystem.getMutationToken(path);
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

interface SequenceInvocation {
  readonly separator: string;
  readonly equalWidth: boolean;
  readonly first: number;
  readonly increment: number;
  readonly last: number;
}

function parseSequence(argv: readonly string[]): SequenceInvocation {
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
  return { separator, equalWidth, first, increment, last };
}

function sequenceValues(context: ShellCommandContext, invocation: SequenceInvocation): number[] {
  const values: number[] = [];
  const ascending = invocation.increment > 0;
  for (
    let value = invocation.first;
    ascending ? value <= invocation.last : value >= invocation.last;
    value += invocation.increment
  ) {
    context.budget.step();
    context.budget.expansionOutput(String(value).length, 1);
    values.push(value);
  }
  return values;
}

function renderSequenceValue(value: number, width: number): string {
  const text = String(value);
  if (width === 0) return text;
  return value < 0 ? `-${text.slice(1).padStart(width - 1, "0")}` : text.padStart(width, "0");
}

/**
 * Prints an integer sequence. Operands are strict decimal integers rather than
 * Bash arithmetic or floating point, matching the project's deterministic
 * integer profile; the produced count charges the shared expansion budget.
 */
export const seqCommand = /* @__PURE__ */ defineApplet(SEQ, async (context, argv, fds) => {
  const invocation = parseSequence(argv);
  const values = sequenceValues(context, invocation);
  const width = invocation.equalWidth
    ? Math.max(0, ...values.map((value) => String(value).length))
    : 0;
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    // The separator joins values; the sequence always ends with one newline,
    // so the default separator produces one record per value.
    for (const [index, value] of values.entries()) {
      await output.write(
        `${index === 0 ? "" : invocation.separator}${renderSequenceValue(value, width)}`,
      );
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

interface Base64Invocation {
  readonly decode: boolean;
  readonly wrap: number;
  readonly path: string | undefined;
}

function parseBase64Invocation(argv: readonly string[]): Base64Invocation {
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
  return { decode, wrap, path: parsed.operands[0] };
}

function decodedBase64(value: string): Uint8Array {
  const compact = value.replace(/[\n\r]/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) {
    throw appletUsageError(BASE64, "invalid input");
  }
  const binary = atob(compact);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decodeBase64(
  context: ShellCommandContext,
  path: string | undefined,
  fds: ShellFileDescriptors,
): Promise<number> {
  const input =
    path === undefined || path === "-"
      ? await collectText(context, fds[0])
      : await readFileText(context, path);
  try {
    await writeBytes(fds[1], decodedBase64(input.value));
    return 0;
  } finally {
    input.release();
  }
}

async function writeEncodedBase64(
  context: ShellCommandContext,
  encoded: string,
  wrap: number,
  fds: ShellFileDescriptors,
): Promise<number> {
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
}

async function encodeBase64(
  context: ShellCommandContext,
  invocation: Base64Invocation,
  fds: ShellFileDescriptors,
): Promise<number> {
  const input =
    invocation.path === undefined || invocation.path === "-"
      ? await collectStream(context, fds[0])
      : await readFileBytes(context, invocation.path);
  try {
    let binary = "";
    for (const byte of input.value) binary += String.fromCharCode(byte);
    return await writeEncodedBase64(context, btoa(binary), invocation.wrap, fds);
  } finally {
    input.release();
  }
}

/** Encodes or decodes standard base64. Decoding rejects invalid input. */
export const base64Command = /* @__PURE__ */ defineApplet(BASE64, async (context, argv, fds) => {
  const invocation = parseBase64Invocation(argv);
  return invocation.decode
    ? decodeBase64(context, invocation.path, fds)
    : encodeBase64(context, invocation, fds);
});
