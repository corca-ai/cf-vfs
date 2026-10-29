import { createLineDiff, renderLineDiff } from "../../core/line-diff.js";
import { basename, compareUtf8 } from "../../core/path.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import {
  type BufferLease,
  collectStream,
  commandPath,
  inputTexts,
  readFileBytes,
  writeText,
} from "./helpers.js";

const CMP = {
  name: "cmp",
  usage: "[-s] FILE1 FILE2",
  summary: "reports the first differing byte of two files",
  options: {
    short: { s: { name: "silent" } },
    long: { silent: { name: "silent" }, quiet: { name: "silent" } },
  },
} as const satisfies AppletSpecWithOptions<"silent">;

const DIFF = {
  name: "diff",
  usage: "[-rqu] FILE1 FILE2",
  summary: "prints a unified difference between two files or directories",
  options: {
    short: { r: { name: "recursive" }, q: { name: "brief" }, u: { name: "unified" } },
    long: {
      recursive: { name: "recursive" },
      brief: { name: "brief" },
      unified: { name: "unified" },
    },
  },
} as const satisfies AppletSpecWithOptions<"recursive" | "brief" | "unified">;

function countNewlines(bytes: Uint8Array, end: number): number {
  let lines = 0;
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0x0a) lines += 1;
  return lines;
}

function firstDifference(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}

/** GNU's end-of-file report, which says whether the shorter file ended mid-line. */
function endOfFileReport(name: string, bytes: Uint8Array): string {
  const length = bytes.byteLength;
  if (length === 0) return `cmp: EOF on ${name} which is empty\n`;
  const lines = countNewlines(bytes, length);
  return bytes[length - 1] === 0x0a
    ? `cmp: EOF on ${name} after byte ${length}, line ${lines}\n`
    : `cmp: EOF on ${name} after byte ${length}, in line ${lines + 1}\n`;
}

async function compareBytes(
  fds: ShellFileDescriptors,
  names: readonly [string, string],
  left: Uint8Array,
  right: Uint8Array,
  silent: boolean,
): Promise<number> {
  const index = firstDifference(left, right);
  const shorter = Math.min(left.byteLength, right.byteLength);
  if (index === shorter && left.byteLength === right.byteLength) return 0;
  if (silent) return 1;
  if (index < shorter) {
    const line = countNewlines(left, index) + 1;
    await writeText(fds[1], `${names[0]} ${names[1]} differ: byte ${index + 1}, line ${line}\n`);
  } else if (left.byteLength < right.byteLength) {
    await writeText(fds[2], endOfFileReport(names[0], left));
  } else {
    await writeText(fds[2], endOfFileReport(names[1], right));
  }
  return 1;
}

/** Compares bytes, reporting the first difference in GNU's words; `-s` reports by status alone. */
export const cmpCommand = /* @__PURE__ */ defineApplet(CMP, async (context, argv, fds) => {
  const parsed = parseAppletOptions(CMP, argv);
  const silent = parsed.options.some((option) => option.name === "silent");
  const [leftName = "", rightName = ""] = parsed.operands;
  if (parsed.operands.length !== 2) throw appletUsageError(CMP, "requires two files");
  if (leftName === "-" && rightName === "-")
    throw appletUsageError(CMP, "only one operand may be -");
  // `-` is standard input, as in `... | cmp - expected`.
  const read = (name: string): Promise<BufferLease<Uint8Array>> =>
    name === "-" ? collectStream(context, fds[0]) : readFileBytes(context, name);
  const left = await read(leftName);
  let right: BufferLease<Uint8Array>;
  try {
    right = await read(rightName);
  } catch (error) {
    left.release();
    throw error;
  }
  try {
    return await compareBytes(fds, [leftName, rightName], left.value, right.value, silent);
  } finally {
    left.release();
    right.release();
  }
});

interface DiffInvocation {
  readonly context: ShellCommandContext;
  readonly fds: ShellFileDescriptors;
  readonly recursive: boolean;
  readonly brief: boolean;
  /** The options as given, which GNU repeats before each differing pair in a directory. */
  readonly flags: string;
}

function isDirectoryOperand(context: ShellCommandContext, operand: string): boolean {
  if (operand === "-") return false;
  return context.fileSystem.stat(commandPath(context, operand)).kind === "directory";
}

function childOperand(directory: string, name: string): string {
  return `${directory.length > 1 ? directory.replace(/\/+$/u, "") : directory}/${name}`;
}

function describeDiffFile(context: ShellCommandContext, operand: string): string {
  const stat = context.fileSystem.stat(commandPath(context, operand));
  if (stat.kind === "directory") return "a directory";
  return stat.sizeBytes === 0 ? "a regular empty file" : "a regular file";
}

async function diffFiles(
  invocation: DiffInvocation,
  left: string,
  right: string,
  header: boolean,
): Promise<number> {
  const inputs = await inputTexts(invocation.context, [left, right], invocation.fds[0]);
  try {
    const diff = createLineDiff(inputs.value[0]?.text ?? "", inputs.value[1]?.text ?? "");
    if (diff.changes === 0) return 0;
    if (invocation.brief) {
      await writeText(invocation.fds[1], `Files ${left} and ${right} differ\n`);
    } else {
      if (header) await writeText(invocation.fds[1], `diff${invocation.flags} ${left} ${right}\n`);
      await writeText(invocation.fds[1], renderLineDiff(left, right, diff));
    }
    return 1;
  } finally {
    inputs.release();
  }
}

interface DirectoryPair {
  readonly left: string;
  readonly right: string;
  readonly leftNames: ReadonlySet<string>;
  readonly rightNames: ReadonlySet<string>;
}

function entryNames(context: ShellCommandContext, operand: string): Set<string> {
  return new Set(
    context.fileSystem.list(commandPath(context, operand)).map((entry) => basename(entry.path)),
  );
}

/** Compares one name present in either directory, returning its status. */
async function diffEntry(
  invocation: DiffInvocation,
  pair: DirectoryPair,
  name: string,
): Promise<number> {
  const { context, fds } = invocation;
  if (!pair.leftNames.has(name) || !pair.rightNames.has(name)) {
    const directory = pair.leftNames.has(name) ? pair.left : pair.right;
    await writeText(fds[1], `Only in ${directory}: ${name}\n`);
    return 1;
  }
  const left = childOperand(pair.left, name);
  const right = childOperand(pair.right, name);
  const leftDirectory = isDirectoryOperand(context, left);
  const rightDirectory = isDirectoryOperand(context, right);
  if (leftDirectory && rightDirectory) {
    if (invocation.recursive) return diffDirectories(invocation, left, right);
    await writeText(fds[1], `Common subdirectories: ${left} and ${right}\n`);
    return 0;
  }
  if (leftDirectory || rightDirectory) {
    const leftKind = describeDiffFile(context, left);
    const rightKind = describeDiffFile(context, right);
    await writeText(fds[1], `File ${left} is ${leftKind} while file ${right} is ${rightKind}\n`);
    return 1;
  }
  return diffFiles(invocation, left, right, true);
}

/** Compares two directories entry by entry in byte order, descending only under `-r`. */
async function diffDirectories(
  invocation: DiffInvocation,
  left: string,
  right: string,
): Promise<number> {
  const pair: DirectoryPair = {
    left,
    right,
    leftNames: entryNames(invocation.context, left),
    rightNames: entryNames(invocation.context, right),
  };
  const names = [...new Set([...pair.leftNames, ...pair.rightNames])].sort(compareUtf8);
  let status = 0;
  for (const name of names) {
    invocation.context.budget.step();
    status = Math.max(status, await diffEntry(invocation, pair, name));
  }
  return status;
}

export const diffCommand = /* @__PURE__ */ defineApplet(DIFF, async (context, argv, fds) => {
  const parsed = parseAppletOptions(DIFF, argv);
  if (parsed.operands.length !== 2) throw appletUsageError(DIFF, "requires two files");
  const [left = "", right = ""] = parsed.operands;
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const flags = argv
    .filter((value) => value.startsWith("-") && value !== "-" && !parsed.operands.includes(value))
    .map((value) => ` ${value}`)
    .join("");
  const invocation: DiffInvocation = {
    context,
    fds,
    recursive: has("recursive"),
    brief: has("brief"),
    flags,
  };
  const leftDirectory = isDirectoryOperand(context, left);
  const rightDirectory = isDirectoryOperand(context, right);
  if (leftDirectory && rightDirectory) return diffDirectories(invocation, left, right);
  // A file against a directory compares it with the file of the same name inside.
  if (leftDirectory)
    return diffFiles(invocation, childOperand(left, basename(right)), right, false);
  if (rightDirectory)
    return diffFiles(invocation, left, childOperand(right, basename(left)), false);
  return diffFiles(invocation, left, right, false);
});
