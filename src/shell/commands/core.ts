import {
  compareDecimalIntegers,
  type NormalizedDecimalInteger,
  normalizeDecimalInteger,
} from "../../core/decimal-integer.js";
import { VfsError } from "../../core/errors.js";
import {
  compareUtf8,
  normalizePath,
  normalizePathPreservingTrailingSlash,
} from "../../core/path.js";
import { type PosixPermission, shellModeAllows } from "../access.js";
import { optindGeneration, setOptindFromGetopts } from "../environment.js";
import { identityLabel, resolveIdentityNames } from "../identity.js";
import { readInputRecord } from "../input.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { isCharacterDevice, isRegularFile } from "./format.js";
import { type BufferLease, commandPath, parseInteger, readFileText, writeText } from "./helpers.js";

const COLON = {
  name: ":",
  usage: "",
  summary: "does nothing and succeeds",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const TRUE = {
  name: "true",
  usage: "",
  summary: "succeeds",
  kind: "builtin",
} as const satisfies AppletSpec;
const FALSE = {
  name: "false",
  usage: "",
  summary: "fails with status 1",
  kind: "builtin",
} as const satisfies AppletSpec;

const ECHO = {
  name: "echo",
  usage: "[-n] [ARGUMENT...]",
  summary: "writes arguments separated by spaces",
  kind: "builtin",
} as const satisfies AppletSpec;

const PRINTF = {
  name: "printf",
  usage: "FORMAT [ARGUMENT...]",
  summary: "formats strings, characters, and integers with POSIX-style conversions",
  kind: "builtin",
} as const satisfies AppletSpec;

const PWD = {
  name: "pwd",
  usage: "",
  summary: "prints the working directory",
  kind: "builtin",
} as const satisfies AppletSpec;

const CD = {
  name: "cd",
  usage: "[DIRECTORY|-]",
  summary: "changes the working directory",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const EXPORT = {
  name: "export",
  usage: "[NAME[=VALUE]...]",
  summary: "marks variables for the session environment",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const ENV = {
  name: "env",
  usage: "[NAME=VALUE...] [COMMAND [ARGUMENT...]]",
  summary: "prints the environment or runs a command with assignments",
} as const satisfies AppletSpec;

const UNSET = {
  name: "unset",
  usage: "[NAME...]",
  summary: "removes variables",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const READ = {
  name: "read",
  usage: "[-r] [--] [NAME...]",
  summary: "reads one record from standard input",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const SHIFT = {
  name: "shift",
  usage: "[COUNT]",
  summary: "drops leading positional parameters",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const GETOPTS = {
  name: "getopts",
  usage: "OPTSTRING NAME [ARGUMENT...]",
  summary: "parses one option from the positional parameters",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const LOCAL = {
  name: "local",
  usage: "NAME[=VALUE]...",
  summary: "declares function-scoped variables",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const RETURN = {
  name: "return",
  usage: "[STATUS]",
  summary: "returns from a function or sourced file",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const BREAK = {
  name: "break",
  usage: "[LEVELS]",
  summary: "exits enclosing loops",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const CONTINUE = {
  name: "continue",
  usage: "[LEVELS]",
  summary: "resumes the next iteration of an enclosing loop",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const EXIT = {
  name: "exit",
  usage: "[STATUS]",
  summary: "ends the execution unit",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const SET = {
  name: "set",
  usage: "[-eu|+eu] [-o|+o OPTION] [-- ARGUMENT...]",
  summary: "sets shell options or positional parameters",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const TEST = {
  name: "test",
  usage: "EXPRESSION",
  summary: "evaluates a bounded conditional expression",
  kind: "builtin",
} as const satisfies AppletSpec;

const BRACKET = {
  name: "[",
  usage: "EXPRESSION ]",
  summary: "evaluates a bounded conditional expression, requiring a closing ]",
  kind: "builtin",
} as const satisfies AppletSpec;

const ID = {
  name: "id",
  usage: "[-u|-g|-G] [-n]",
  summary: "prints the execution identity",
  options: {
    short: {
      u: { name: "user" },
      g: { name: "group" },
      G: { name: "groups" },
      n: { name: "name" },
    },
  },
} as const satisfies AppletSpecWithOptions<"user" | "group" | "groups" | "name">;

const GROUPS = {
  name: "groups",
  usage: "",
  summary: "prints the execution groups",
} as const satisfies AppletSpec;

export const colonCommand = /* @__PURE__ */ defineApplet(COLON, () => 0);
export const trueCommand = /* @__PURE__ */ defineApplet(TRUE, () => 0);
export const falseCommand = /* @__PURE__ */ defineApplet(FALSE, () => 1);

export const echoCommand = /* @__PURE__ */ defineApplet(ECHO, async (_context, argv, fds) => {
  let newline = true;
  let start = 0;
  if (argv[0] === "-n") {
    newline = false;
    start = 1;
  }
  await writeText(fds[1], `${argv.slice(start).join(" ")}${newline ? "\n" : ""}`);
  return 0;
});

function formatPrintfOnce(
  format: string,
  values: readonly string[],
  maximumOutputCharacters: number,
): {
  output: string;
  consumed: number;
  diagnostics: string[];
} {
  let index = 0;
  let output = "";
  const diagnostics: string[] = [];
  const append = (value: string): void => {
    if (output.length + value.length > maximumOutputCharacters) {
      throw new VfsError("E2BIG", "printf output exceeds the execution limit");
    }
    output += value;
  };
  for (let offset = 0; offset < format.length; offset += 1) {
    const character = format[offset];
    if (character === "\\") {
      const next = format[++offset];
      if (next === "n") append("\n");
      else if (next === "t") append("\t");
      else if (next === "r") append("\r");
      else if (next === "\\") append("\\");
      else append(next === undefined ? "\\" : `\\${next}`);
      continue;
    }
    if (character !== "%") {
      append(character ?? "");
      continue;
    }
    const conversion = /^([-+ #0]*)(\*|[0-9]*)(?:\.(\*|[0-9]*))?([A-Za-z%])/u.exec(
      format.slice(offset + 1),
    );
    if (conversion === null) {
      throw appletUsageError(PRINTF, `unsupported conversion %${format[offset + 1] ?? ""}`);
    }
    offset += conversion[0].length;
    let flags = conversion[1] ?? "";
    const widthToken = conversion[2] ?? "";
    let width: number | undefined;
    if (widthToken === "*") {
      const field = parsePrintfDynamicFieldSize(
        values[index++] ?? "0",
        "field width",
        maximumOutputCharacters,
        false,
      );
      width = field.value;
      if (field.left) flags += "-";
      if (field.diagnostic !== undefined) diagnostics.push(field.diagnostic);
    } else {
      width = parsePrintfFieldSize(widthToken, "field width", maximumOutputCharacters);
    }
    const precisionToken = conversion[3];
    let precision: number | undefined;
    if (precisionToken === "*") {
      const field = parsePrintfDynamicFieldSize(
        values[index++] ?? "0",
        "precision",
        maximumOutputCharacters,
        true,
      );
      precision = field.value;
      if (field.diagnostic !== undefined) diagnostics.push(field.diagnostic);
    } else if (precisionToken !== undefined) {
      precision = parsePrintfFieldSize(precisionToken, "precision", maximumOutputCharacters, 0);
    }
    const specifier = conversion[4] ?? "";
    if (specifier === "%") {
      if (flags !== "" || width !== undefined || precision !== undefined) {
        throw appletUsageError(PRINTF, "flags, width, and precision do not apply to %%");
      }
      append("%");
    } else if (specifier === "s" || specifier === "b" || specifier === "c") {
      assertPrintfFlags(flags, "-");
      if (specifier === "c" && precision !== undefined) {
        throw appletUsageError(PRINTF, "precision does not apply to %c");
      }
      const argument = values[index++] ?? "";
      const value =
        specifier === "b"
          ? decodeBackslashEscapes(argument)
          : specifier === "c"
            ? ([...argument][0] ?? "")
            : argument;
      append(formatPrintfText(value, width, precision, flags.includes("-")));
    } else if (/^[diouxX]$/u.test(specifier)) {
      const signed = specifier === "d" || specifier === "i";
      assertPrintfFlags(flags, signed ? "-+ 0" : specifier === "u" ? "-0" : "-#0");
      const parsed = parsePrintfInteger(values[index++] ?? "0", !signed);
      append(formatPrintfInteger(parsed.value, specifier, flags, width, precision));
      if (parsed.diagnostic !== undefined) diagnostics.push(parsed.diagnostic);
    } else {
      throw appletUsageError(PRINTF, `unsupported conversion %${specifier}`);
    }
  }
  return { output, consumed: index, diagnostics };
}

const MIN_PRINTF_INTEGER = -(1n << 63n);
const MAX_PRINTF_INTEGER = (1n << 63n) - 1n;
const MAX_PRINTF_UNSIGNED_INTEGER = (1n << 64n) - 1n;

function parsePrintfFieldSize(
  digits: string,
  label: string,
  maximum: number,
  empty?: number,
): number | undefined {
  if (digits === "") return empty;
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new VfsError("E2BIG", `printf ${label} exceeds the execution limit`);
  }
  return value;
}

function parsePrintfDynamicFieldSize(
  input: string,
  label: string,
  maximum: number,
  negativeIsOmitted: boolean,
): { value: number | undefined; left: boolean; diagnostic?: string } {
  const parsed = parsePrintfInteger(input);
  if (negativeIsOmitted && parsed.value < 0) {
    return {
      value: undefined,
      left: false,
      ...(parsed.diagnostic === undefined ? {} : { diagnostic: parsed.diagnostic }),
    };
  }
  const left = parsed.value < 0;
  const magnitude = left ? -parsed.value : parsed.value;
  if (magnitude > BigInt(maximum)) {
    throw new VfsError("E2BIG", `printf ${label} exceeds the execution limit`);
  }
  return {
    value: Number(magnitude),
    left,
    ...(parsed.diagnostic === undefined ? {} : { diagnostic: parsed.diagnostic }),
  };
}

function assertPrintfFlags(flags: string, supported: string): void {
  for (const flag of flags) {
    if (!supported.includes(flag)) {
      throw appletUsageError(PRINTF, `unsupported flag ${flag}`);
    }
  }
}

function formatPrintfText(
  value: string,
  width: number | undefined,
  precision: number | undefined,
  left: boolean,
): string {
  if (width === undefined && precision === undefined) return value;
  const characters = [...value];
  const rendered = precision === undefined ? value : characters.slice(0, precision).join("");
  const padding = Math.max(0, (width ?? 0) - Math.min(characters.length, precision ?? Infinity));
  return left ? rendered + " ".repeat(padding) : " ".repeat(padding) + rendered;
}

function formatPrintfInteger(
  value: bigint,
  specifier: string,
  flags: string,
  width: number | undefined,
  precision: number | undefined,
): string {
  const signed = specifier === "d" || specifier === "i";
  const radix = specifier === "o" ? 8 : specifier === "x" || specifier === "X" ? 16 : 10;
  const negative = signed && value < 0;
  const magnitude = signed ? (negative ? -value : value) : BigInt.asUintN(64, value);
  let digits = magnitude.toString(radix);
  if (specifier === "X") digits = digits.toUpperCase();
  if (precision === 0 && magnitude === 0n) digits = "";
  else if (precision !== undefined) digits = digits.padStart(precision, "0");

  let prefix = negative ? "-" : signed && flags.includes("+") ? "+" : "";
  if (prefix === "" && signed && flags.includes(" ")) prefix = " ";
  if (flags.includes("#") && specifier === "o" && !digits.startsWith("0")) prefix += "0";
  else if (flags.includes("#") && magnitude !== 0n && (specifier === "x" || specifier === "X")) {
    prefix += specifier === "x" ? "0x" : "0X";
  }

  const padding = Math.max(0, (width ?? 0) - prefix.length - digits.length);
  if (flags.includes("-")) return prefix + digits + " ".repeat(padding);
  if (flags.includes("0") && precision === undefined) return prefix + "0".repeat(padding) + digits;
  return " ".repeat(padding) + prefix + digits;
}

function parsePrintfInteger(
  value: string,
  unsigned = false,
): { value: bigint; diagnostic?: string } {
  if (value.startsWith("'") || value.startsWith('"')) {
    const character = [...value.slice(1)][0];
    if (character !== undefined) return { value: BigInt(character.codePointAt(0) ?? 0) };
  }

  const input = value.trimStart();
  const sign = input.startsWith("-") ? -1n : 1n;
  const magnitudeInput = input.startsWith("-") || input.startsWith("+") ? input.slice(1) : input;
  let digits = "";
  let consumed = 0;
  let radix: 8 | 10 | 16 = 10;
  if (/^0[xX]/u.test(magnitudeInput)) {
    radix = 16;
    digits = /^[0-9a-f]+/iu.exec(magnitudeInput.slice(2))?.[0] ?? "";
    consumed = 2 + digits.length;
  } else if (magnitudeInput.startsWith("0")) {
    radix = 8;
    digits = /^0[0-7]*/u.exec(magnitudeInput)?.[0] ?? "";
    consumed = digits.length;
  } else {
    digits = /^[0-9]+/u.exec(magnitudeInput)?.[0] ?? "";
    consumed = digits.length;
  }

  let parsed = 0n;
  if (digits.length > 0) {
    if (radix === 16) parsed = BigInt(`0x${digits}`);
    else if (radix === 8) parsed = BigInt(`0o${digits}`);
    else parsed = BigInt(digits);
    parsed *= sign;
  }

  let diagnostic: string | undefined;
  const remaining = magnitudeInput.slice(consumed);
  if (digits.length === 0 || remaining.length > 0) {
    const message =
      radix === 8 && /^[89]/u.test(remaining) ? "invalid octal number" : "invalid number";
    diagnostic = `printf: ${value}: ${message}\n`;
  }
  const maximum = unsigned ? MAX_PRINTF_UNSIGNED_INTEGER : MAX_PRINTF_INTEGER;
  if (parsed < MIN_PRINTF_INTEGER || parsed > maximum) {
    parsed = parsed < MIN_PRINTF_INTEGER ? MIN_PRINTF_INTEGER : maximum;
    diagnostic = `printf: ${value}: Result not representable\n`;
  }
  return { value: parsed, ...(diagnostic === undefined ? {} : { diagnostic }) };
}

function decodeBackslashEscapes(value: string): string {
  let output = "";
  for (let offset = 0; offset < value.length; offset += 1) {
    const character = value[offset];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = value[++offset];
    if (next === "n") output += "\n";
    else if (next === "t") output += "\t";
    else if (next === "r") output += "\r";
    else if (next === "\\") output += "\\";
    else output += next === undefined ? "\\" : `\\${next}`;
  }
  return output;
}

function formatPrintf(
  format: string,
  values: readonly string[],
  maximumOutputCharacters: number,
): {
  output: string;
  diagnostics: string[];
} {
  let output = "";
  const diagnostics: string[] = [];
  let offset = 0;
  do {
    const result = formatPrintfOnce(format, values.slice(offset), maximumOutputCharacters);
    if (output.length + result.output.length > maximumOutputCharacters) {
      throw new VfsError("E2BIG", "printf output exceeds the execution limit");
    }
    output += result.output;
    diagnostics.push(...result.diagnostics);
    offset += result.consumed;
    if (result.consumed === 0) break;
  } while (offset < values.length);
  return { output, diagnostics };
}

export const printfCommand = /* @__PURE__ */ defineApplet(PRINTF, async (context, argv, fds) => {
  // `--` ends the options, so a format that begins with a dash can still be
  // written. `printf` has no options here, but a caller writing portable
  // scripts has no way to know that.
  const operands = argv[0] === "--" ? argv.slice(1) : argv;
  if (operands.length === 0) throw appletUsageError(PRINTF, "missing format");
  const formatted = formatPrintf(
    operands[0] ?? "",
    operands.slice(1),
    context.budget.limits.maxStdoutBytes,
  );
  await Promise.all([
    writeText(fds[1], formatted.output),
    formatted.diagnostics.length === 0
      ? Promise.resolve()
      : writeText(fds[2], formatted.diagnostics.join("")),
  ]);
  return formatted.diagnostics.length === 0 ? 0 : 1;
});

export const pwdCommand = /* @__PURE__ */ defineApplet(PWD, async (context, argv, fds) => {
  if (argv.length > 0) throw appletUsageError(PWD, `unsupported option ${argv[0] ?? ""}`);
  await writeText(fds[1], `${context.session.cwd}\n`);
  return 0;
});

export const cdCommand = /* @__PURE__ */ defineApplet(CD, async (context, argv, fds) => {
  if (argv.length > 1) throw appletUsageError(CD, "too many arguments");
  const [operand] = argv;
  if (operand === "") throw appletUsageError(CD, "directory must not be empty");
  const previous = context.session.cwd;
  let requested: string;
  if (operand === "-") {
    const old = context.session.env.get("OLDPWD");
    // Bash refuses rather than guessing when there is no previous directory.
    if (old === undefined || old === "") throw appletUsageError(CD, "OLDPWD not set");
    requested = old;
  } else if (operand === undefined) {
    const home = context.session.env.get("HOME");
    if (home === undefined || home === "") throw appletUsageError(CD, "HOME not set");
    requested = home;
  } else {
    requested = operand;
  }
  const target = normalizePath(requested, previous);
  const stat = context.fileSystem.stat(target);
  if (stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", target);
  context.session.cwd = target;
  context.session.env.set("OLDPWD", previous);
  context.session.env.set("PWD", target);
  // `cd -` reports where it went, as Bash does, so a script can see the swap.
  if (operand === "-") await writeText(fds[1], `${target}\n`);
  return 0;
});

function assignment(value: string): { name: string; value: string } {
  const separator = value.indexOf("=");
  const name = separator < 0 ? value : value.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new VfsError("EINVAL", `invalid variable name: ${name}`);
  }
  return { name, value: separator < 0 ? "" : value.slice(separator + 1) };
}

export const exportCommand = /* @__PURE__ */ defineApplet(EXPORT, (context, argv) => {
  for (const value of argv) {
    const parsed = assignment(value);
    context.session.env.set(
      parsed.name,
      value.includes("=") ? parsed.value : (context.session.env.get(parsed.name) ?? ""),
    );
  }
  return 0;
});

/**
 * Prints the session environment, or runs a command with added assignments.
 *
 * Names sort by UTF-8 byte order so output is deterministic. Bash's `-i`,
 * `-u`, and `-0` options and the bare `-` form are outside this profile;
 * positional-parameter and shell-option state is not environment.
 */
export const envCommand = /* @__PURE__ */ defineApplet(ENV, async (context, argv, fds) => {
  let index = 0;
  const assignments: Array<{ name: string; value: string }> = [];
  while (index < argv.length) {
    const value = argv[index] ?? "";
    if (value === "--") {
      index += 1;
      break;
    }
    if (value.startsWith("-")) throw appletUsageError(ENV, `unsupported option ${value}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) break;
    const separator = value.indexOf("=");
    assignments.push({ name: value.slice(0, separator), value: value.slice(separator + 1) });
    index += 1;
  }

  const invocation = argv.slice(index);
  if (invocation.length === 0) {
    for (const { name, value } of assignments) context.session.env.set(name, value);
    const names = [...context.session.env.keys()]
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      .sort(compareUtf8);
    let output = "";
    for (const name of names) output += `${name}=${context.session.env.get(name) ?? ""}\n`;
    await writeText(fds[1], output);
    return 0;
  }

  // Assignments apply only to the invoked command, exactly like a prefixed
  // assignment on an ordinary simple command.
  const previous = new Map<string, string | undefined>();
  for (const { name, value } of assignments) {
    previous.set(name, context.session.env.get(name));
    context.session.env.set(name, value);
  }
  try {
    return await context.executeCommand(invocation, fds);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) context.session.env.delete(name);
      else context.session.env.set(name, value);
    }
  }
});

export const unsetCommand = /* @__PURE__ */ defineApplet(UNSET, (context, argv) => {
  for (const name of argv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw appletUsageError(UNSET, `invalid variable name: ${name}`);
    }
    context.session.env.delete(name);
  }
  return 0;
});

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const READ_IFS = /[ \t\n]/u;
const READ_ENCODER = new TextEncoder();

function readVariableNames(argv: readonly string[]): {
  names: string[];
  reply: boolean;
  raw: boolean;
} {
  let offset = 0;
  const raw = argv[offset] === "-r";
  if (raw) offset += 1;
  if (argv[offset] === "--") offset += 1;
  const unsupported = argv[offset]?.startsWith("-") === true ? argv[offset] : undefined;
  if (unsupported !== undefined) throw appletUsageError(READ, `unsupported option ${unsupported}`);
  const operands = argv.slice(offset);
  const names = operands.length === 0 ? ["REPLY"] : [...operands];
  for (const name of names) {
    if (!VARIABLE_NAME.test(name)) {
      throw appletUsageError(READ, `invalid variable name: ${name}`);
    }
  }
  return { names, reply: operands.length === 0, raw };
}

interface EscapedReadValue {
  value: string;
  escapedIfs: ReadonlySet<number>;
  continued: boolean;
}

function decodeReadRecord(value: string): EscapedReadValue {
  let output = "";
  const escapedIfs = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      output += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) return { value: output, escapedIfs, continued: true };
    if (READ_IFS.test(escaped)) escapedIfs.add(output.length);
    output += escaped;
  }
  return { value: output, escapedIfs, continued: false };
}

async function readEscapedRecord(
  fds: ShellFileDescriptors,
  context: ShellCommandContext,
): Promise<{ value: string; escapedIfs: ReadonlySet<number>; terminated: boolean }> {
  let value = "";
  const escapedIfs = new Set<number>();
  let retainedBytes = 0;
  let release: () => void = () => undefined;
  try {
    while (true) {
      const record = await readInputRecord(fds[0], context.budget, context.signal);
      const decoded = decodeReadRecord(record.value);
      retainedBytes += READ_ENCODER.encode(decoded.value).byteLength;
      if (retainedBytes > context.budget.limits.maxLineBytes) {
        throw new VfsError("E2BIG", "read: logical line byte limit exceeded");
      }
      release();
      release = context.budget.buffered(retainedBytes);
      const base = value.length;
      value += decoded.value;
      for (const offset of decoded.escapedIfs) escapedIfs.add(base + offset);
      if (!decoded.continued || !record.terminated) {
        return { value, escapedIfs, terminated: record.terminated };
      }
    }
  } finally {
    release();
  }
}

function readRawAssignments(
  value: string,
  names: readonly string[],
  reply: boolean,
): Array<{ name: string; value: string }> {
  if (reply) return [{ name: "REPLY", value }];
  const assignments: Array<{ name: string; value: string }> = [];
  let offset = 0;
  while (offset < value.length && READ_IFS.test(value[offset] ?? "")) offset += 1;
  for (const [index, name] of names.entries()) {
    if (index === names.length - 1) {
      let end = value.length;
      while (end > offset && READ_IFS.test(value[end - 1] ?? "")) end -= 1;
      assignments.push({ name, value: value.slice(offset, end) });
      break;
    }
    let end = offset;
    while (end < value.length && !READ_IFS.test(value[end] ?? "")) end += 1;
    assignments.push({ name, value: value.slice(offset, end) });
    offset = end;
    while (offset < value.length && READ_IFS.test(value[offset] ?? "")) offset += 1;
  }
  return assignments;
}

function readEscapedAssignments(
  value: string,
  escapedIfs: ReadonlySet<number>,
  names: readonly string[],
  reply: boolean,
): Array<{ name: string; value: string }> {
  const delimiter = (offset: number): boolean =>
    !escapedIfs.has(offset) && READ_IFS.test(value[offset] ?? "");
  if (reply) return [{ name: "REPLY", value }];
  const assignments: Array<{ name: string; value: string }> = [];
  let offset = 0;
  while (offset < value.length && delimiter(offset)) offset += 1;
  for (const [index, name] of names.entries()) {
    if (index === names.length - 1) {
      let end = value.length;
      while (end > offset && delimiter(end - 1)) end -= 1;
      assignments.push({ name, value: value.slice(offset, end) });
      break;
    }
    let end = offset;
    while (end < value.length && !delimiter(end)) end += 1;
    assignments.push({ name, value: value.slice(offset, end) });
    offset = end;
    while (offset < value.length && delimiter(offset)) offset += 1;
  }
  return assignments;
}

export const readCommand = /* @__PURE__ */ defineApplet(READ, async (context, argv, fds) => {
  const { names, reply, raw } = readVariableNames(argv);
  let assignments: Array<{ name: string; value: string }>;
  let terminated: boolean;
  if (raw) {
    const record = await readInputRecord(fds[0], context.budget, context.signal);
    assignments = readRawAssignments(record.value, names, reply);
    terminated = record.terminated;
  } else {
    const record = await readEscapedRecord(fds, context);
    assignments = readEscapedAssignments(record.value, record.escapedIfs, names, reply);
    terminated = record.terminated;
  }
  for (const value of assignments) {
    context.session.env.set(value.name, value.value);
  }
  return terminated ? 0 : 1;
});

export const shiftCommand = /* @__PURE__ */ defineApplet(SHIFT, (context, argv) => {
  if (argv.length > 1) throw appletUsageError(SHIFT, "too many arguments");
  const count = argv[0] === undefined ? 1 : parseInteger(argv[0], `${SHIFT.name}: count`);
  if (count > context.session.args.length) return 1;
  context.session.args.splice(0, count);
  return 0;
});

function validateGetoptsSpec(optstring: string, name: string): void {
  if (!VARIABLE_NAME.test(name)) {
    throw appletUsageError(GETOPTS, `invalid variable name: ${name}`);
  }
  const specification = optstring.startsWith(":") ? optstring.slice(1) : optstring;
  for (let index = 0; index < specification.length; index += 1) {
    const option = specification[index] ?? "";
    if (option === ":" || option === "?" || option === "-") {
      throw appletUsageError(GETOPTS, `invalid option specification: ${option}`);
    }
    if (specification[index + 1] === ":") index += 1;
  }
}

export const getoptsCommand = /* @__PURE__ */ defineApplet(GETOPTS, async (context, argv, fds) => {
  if (argv.length < 2) {
    throw appletUsageError(GETOPTS, "expected optstring and variable name");
  }
  const [optstring = "", name = "", ...explicitArgs] = argv;
  validateGetoptsSpec(optstring, name);
  const args = explicitArgs.length === 0 ? context.session.args : explicitArgs;
  const optind = parseInteger(
    context.session.env.get("OPTIND") ?? "1",
    `${GETOPTS.name}: OPTIND`,
    1,
  );
  const previous = context.session.getopts;
  let argumentIndex = optind - 1;
  let characterIndex =
    previous !== undefined &&
    previous.optind === optind &&
    previous.optindGeneration === optindGeneration(context.session.env)
      ? previous.characterIndex
      : 1;
  const silent = optstring.startsWith(":");
  const specification = silent ? optstring.slice(1) : optstring;

  const save = (nextOptind: number, nextCharacterIndex: number): void => {
    setOptindFromGetopts(context.session.env, String(nextOptind));
    context.session.getopts = {
      optind: nextOptind,
      characterIndex: nextCharacterIndex,
      optindGeneration: optindGeneration(context.session.env),
    };
  };
  const finish = (nextOptind: number): number => {
    save(nextOptind, 1);
    context.session.env.set(name, "?");
    context.session.env.delete("OPTARG");
    return 1;
  };

  while (true) {
    const argument = args[argumentIndex];
    if (argument === undefined || argument === "-" || !argument.startsWith("-")) {
      return finish(argumentIndex + 1);
    }
    if (argument === "--") return finish(argumentIndex + 2);
    if (characterIndex >= argument.length) {
      argumentIndex += 1;
      characterIndex = 1;
      continue;
    }

    const option = argument[characterIndex] ?? "";
    const definition = option === ":" ? -1 : specification.indexOf(option);
    const requiresArgument = definition >= 0 && specification[definition + 1] === ":";
    let nextOptind = argumentIndex + 1;
    let nextCharacterIndex = characterIndex + 1;
    if (nextCharacterIndex >= argument.length) {
      nextOptind += 1;
      nextCharacterIndex = 1;
    }

    if (definition < 0) {
      save(nextOptind, nextCharacterIndex);
      context.session.env.set(name, "?");
      if (silent) context.session.env.set("OPTARG", option);
      else {
        context.session.env.delete("OPTARG");
        await writeText(fds[2], `getopts: illegal option -- ${option}\n`);
      }
      return 0;
    }

    if (!requiresArgument) {
      save(nextOptind, nextCharacterIndex);
      context.session.env.set(name, option);
      context.session.env.delete("OPTARG");
      return 0;
    }

    let optionArgument: string | undefined;
    if (characterIndex + 1 < argument.length) {
      optionArgument = argument.slice(characterIndex + 1);
      nextOptind = argumentIndex + 2;
      nextCharacterIndex = 1;
    } else if (args[argumentIndex + 1] !== undefined) {
      optionArgument = args[argumentIndex + 1];
      nextOptind = argumentIndex + 3;
      nextCharacterIndex = 1;
    }
    if (optionArgument !== undefined) {
      save(nextOptind, nextCharacterIndex);
      context.session.env.set(name, option);
      context.session.env.set("OPTARG", optionArgument);
      return 0;
    }

    save(argumentIndex + 2, 1);
    if (silent) {
      context.session.env.set(name, ":");
      context.session.env.set("OPTARG", option);
    } else {
      context.session.env.set(name, "?");
      context.session.env.delete("OPTARG");
      await writeText(fds[2], `getopts: option requires an argument -- ${option}\n`);
    }
    return 0;
  }
});

function defineSourceCommand(name: "source" | ".") {
  // `source` and `.` share one runner but keep separate specifications so a
  // diagnostic names the spelling the script actually used, exactly as Bash
  // does. They are built-ins: the file runs in the calling shell scope.
  const spec = {
    name,
    usage: "FILE [ARGUMENT...]",
    summary: "runs a bounded VFS file in the current shell scope",
    kind: "session-builtin",
  } as const satisfies AppletSpec;
  return defineApplet(spec, async (context, argv, fds) => {
    const [path, ...args] = argv;
    if (path === undefined) throw appletUsageError(spec, "missing file operand");
    const normalized = commandPath(context, path);
    let source: BufferLease<string>;
    try {
      source = await readFileText(context, normalized, context.budget.limits.maxScriptBytes);
    } catch (error) {
      if (
        error instanceof VfsError &&
        error.code === "E2BIG" &&
        error.message === "buffered command input limit exceeded"
      ) {
        throw new VfsError("E2BIG", "sourced file exceeds the script byte limit", normalized);
      }
      throw error;
    }
    try {
      if (source.value.includes("\0")) {
        throw new VfsError("EINVAL", "sourced file contains a NUL byte", normalized);
      }
      return await context.executeSource(source.value, normalized, args, fds);
    } finally {
      source.release();
    }
  });
}

export const sourceCommand = /* @__PURE__ */ defineSourceCommand("source");
export const dotCommand = /* @__PURE__ */ defineSourceCommand(".");

export const localCommand = /* @__PURE__ */ defineApplet(LOCAL, (context, argv) => {
  const frame = context.session.localFrames.at(-1);
  const getoptsFrame = context.session.localGetoptsFrames.at(-1);
  if (context.session.functionDepth === 0 || frame === undefined || getoptsFrame === undefined) {
    throw appletUsageError(LOCAL, "can only be used in a function");
  }
  for (const value of argv) {
    const parsed = assignment(value);
    if (!frame.has(parsed.name)) frame.set(parsed.name, context.session.env.get(parsed.name));
    if (parsed.name === "OPTIND" && !getoptsFrame.captured) {
      getoptsFrame.captured = true;
      getoptsFrame.state =
        context.session.getopts === undefined ? undefined : { ...context.session.getopts };
    }
    context.session.env.set(parsed.name, value.includes("=") ? parsed.value : "");
  }
  return 0;
});

export const returnCommand = /* @__PURE__ */ defineApplet(RETURN, (context, argv) => {
  if (context.session.functionDepth === 0 && context.session.sourceDepth === 0) {
    throw appletUsageError(RETURN, "can only be used in a function or sourced file");
  }
  if (argv.length > 1) throw appletUsageError(RETURN, "too many arguments");
  const status =
    argv[0] === undefined
      ? context.session.lastExitCode
      : parseInteger(argv[0], `${RETURN.name}: status`, Number.MIN_SAFE_INTEGER) & 0xff;
  context.session.flow = { type: "return", status };
  return status;
});

function loopControl(
  spec: AppletSpec & { readonly name: "break" | "continue" },
  context: ShellCommandContext,
  argv: readonly string[],
): number {
  if (context.session.loopDepth === 0) {
    throw appletUsageError(spec, "only meaningful in a loop");
  }
  if (argv.length > 1) throw appletUsageError(spec, "too many arguments");
  const requested = argv[0] === undefined ? 1 : parseInteger(argv[0], `${spec.name}: level`);
  if (requested <= 0) throw appletUsageError(spec, "level must be positive");
  context.session.flow = {
    type: spec.name,
    levels: Math.min(requested, context.session.loopDepth),
  };
  return 0;
}

export const breakCommand = /* @__PURE__ */ defineApplet(BREAK, (context, argv) =>
  loopControl(BREAK, context, argv),
);

export const continueCommand = /* @__PURE__ */ defineApplet(CONTINUE, (context, argv) =>
  loopControl(CONTINUE, context, argv),
);

export const exitCommand = /* @__PURE__ */ defineApplet(EXIT, (context, argv) => {
  if (argv.length > 1) throw appletUsageError(EXIT, "too many arguments");
  const code =
    argv[0] === undefined
      ? context.session.lastExitCode
      : parseInteger(argv[0], `${EXIT.name}: status`, Number.MIN_SAFE_INTEGER);
  context.session.exitRequested = true;
  context.session.requestedExitCode = code & 0xff;
  return context.session.requestedExitCode;
});

/** Short flags `set` accepts, and the option each one names. */
const SET_FLAGS: Readonly<Record<string, "errexit" | "nounset">> = {
  e: "errexit",
  u: "nounset",
};

/** Long option names `set -o` accepts. */
const SET_OPTIONS = ["errexit", "nounset", "pipefail"] as const;

function applyShellOption(
  session: ShellCommandContext["session"],
  option: (typeof SET_OPTIONS)[number],
  enabled: boolean,
): void {
  if (option === "errexit") session.errexit = enabled;
  else if (option === "nounset") session.nounset = enabled;
  else session.pipefail = enabled;
}

export const setCommand = /* @__PURE__ */ defineApplet(SET, (context, argv) => {
  if (argv.length === 0) return 0;
  // Scan the whole invocation before applying any of it. Bash validates first,
  // so a typo in `set -euo pipefail` is a survivable usage error rather than a
  // half-applied state that then enables errexit and aborts the script.
  const pending: Array<{ option: (typeof SET_OPTIONS)[number]; enabled: boolean }> = [];
  let positional: readonly string[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (value === "--") {
      positional = argv.slice(index + 1);
      break;
    }
    const enabled = value.startsWith("-");
    if ((!enabled && !value.startsWith("+")) || value.length < 2) {
      throw appletUsageError(SET, `unsupported form: ${value}`);
    }
    // Short flags cluster, so `set -eu`, `set +eu`, and `set -uo nounset` all
    // behave as one word; a clustered `o` takes the next word as its name.
    for (const flag of value.slice(1)) {
      if (flag === "o") {
        const name = argv[++index];
        if (name === undefined) throw appletUsageError(SET, "-o requires an option name");
        const option = SET_OPTIONS.find((candidate) => candidate === name);
        if (option === undefined) throw appletUsageError(SET, `unsupported option name: ${name}`);
        pending.push({ option, enabled });
        continue;
      }
      const option = Object.hasOwn(SET_FLAGS, flag) ? SET_FLAGS[flag] : undefined;
      if (option === undefined) throw appletUsageError(SET, `unsupported option -${flag}`);
      pending.push({ option, enabled });
    }
  }
  for (const { option, enabled } of pending) applyShellOption(context.session, option, enabled);
  if (positional !== undefined)
    context.session.args.splice(0, context.session.args.length, ...positional);
  return 0;
});

/** Unary predicates that consult namespace metadata. */
const FILE_PREDICATES = ["-e", "-f", "-d", "-s", "-r", "-w", "-x", "-L", "-h", "-c"] as const;
type FilePredicate = (typeof FILE_PREDICATES)[number];
type PermissionPredicate = "-r" | "-w" | "-x";

const PERMISSION_BITS: Readonly<Record<PermissionPredicate, PosixPermission>> = {
  "-r": 4,
  "-w": 2,
  "-x": 1,
};

function normalizeTestInteger(value: string): NormalizedDecimalInteger {
  const normalized = normalizeDecimalInteger(value);
  if (normalized === undefined) {
    throw appletUsageError(TEST, "integer expression expected");
  }
  return normalized;
}

function compareTestIntegers(left: string, right: string): number {
  return compareDecimalIntegers(normalizeTestInteger(left), normalizeTestInteger(right));
}

async function evaluateTest(
  context: ShellCommandContext,
  values: readonly string[],
): Promise<boolean> {
  if (values.length === 0) return false;
  if (values[0] === "!") return !(await evaluateTest(context, values.slice(1)));
  if (values.length === 1) return values[0] !== "";
  const unary = values[0];
  const operand = values[1];
  if (values.length === 2 && operand !== undefined) {
    if (unary === "-n") return operand.length > 0;
    if (unary === "-z") return operand.length === 0;
    if (FILE_PREDICATES.includes(unary as FilePredicate)) {
      if (operand.length === 0) return false;
      try {
        const path = normalizePathPreservingTrailingSlash(operand, context.session.cwd);
        // `-L` and `-h` ask about the link itself; every other predicate asks
        // about what it points at, which is why a dangling link fails `-e`.
        const asks = unary === "-L" || unary === "-h";
        const stat = asks ? context.fileSystem.lstat(path) : context.fileSystem.stat(path);
        if (asks) return stat.kind === "symlink";
        if (unary === "-c") return isCharacterDevice(stat);
        if (unary === "-e") return true;
        // A regular file, which a character device is not.
        if (unary === "-f") {
          return stat.kind === "file" && isRegularFile(stat);
        }
        if (unary === "-d") return stat.kind === "directory";
        if (unary === "-s") return stat.sizeBytes > 0;
        return shellModeAllows(
          stat,
          context.session.credentials,
          PERMISSION_BITS[unary as PermissionPredicate],
        );
      } catch (error) {
        if (error instanceof VfsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          return false;
        }
        throw error;
      }
    }
  }
  if (values.length === 3) {
    const [left = "", operator = "", right = ""] = values;
    if (operator === "=" || operator === "==") return left === right;
    if (operator === "!=") return left !== right;
    if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(operator)) {
      const order = compareTestIntegers(left, right);
      if (operator === "-eq") return order === 0;
      if (operator === "-ne") return order !== 0;
      if (operator === "-lt") return order < 0;
      if (operator === "-le") return order <= 0;
      if (operator === "-gt") return order > 0;
      return order >= 0;
    }
  }
  throw appletUsageError(TEST, "unsupported expression");
}

export const testCommand = /* @__PURE__ */ defineApplet(TEST, async (context, argv) =>
  (await evaluateTest(context, argv)) ? 0 : 1,
);

export const bracketCommand = /* @__PURE__ */ defineApplet(BRACKET, async (context, argv) => {
  if (argv.at(-1) !== "]") throw appletUsageError(BRACKET, "missing ]");
  return (await evaluateTest(context, argv.slice(0, -1))) ? 0 : 1;
});

function executionIdentity(context: ShellCommandContext, spec: AppletSpec) {
  const credentials = context.session.credentials;
  if (credentials === undefined) {
    throw new VfsError("ENOTSUP", `${spec.name} requires execution credentials`);
  }
  const groups = [...new Set([credentials.gid, ...credentials.supplementaryGids])];
  return { credentials, groups };
}

function annotatedIdentity(id: number, names: ReadonlyMap<number, string> | undefined): string {
  const name = names?.get(id);
  return name === undefined ? String(id) : `${id}(${name})`;
}

export const idCommand = /* @__PURE__ */ defineApplet(ID, async (context, argv, fds) => {
  const parsed = parseAppletOptions(ID, argv);
  if (parsed.operands.length > 0) throw appletUsageError(ID, "user lookup is not supported");
  const selections = parsed.options.filter(
    (option) => option.name === "user" || option.name === "group" || option.name === "groups",
  );
  if (selections.length > 1) throw appletUsageError(ID, "supports only one of -u, -g, or -G");
  const names = parsed.options.some((option) => option.name === "name");
  if (names && selections.length === 0) {
    throw appletUsageError(ID, "-n requires -u, -g, or -G");
  }
  const { credentials, groups } = executionIdentity(context, ID);
  const selection = selections[0]?.name;
  const identityUids =
    selection === undefined || (selection === "user" && names) ? [credentials.uid] : [];
  const identityGids =
    selection === undefined
      ? groups
      : names && selection === "group"
        ? [credentials.gid]
        : names && selection === "groups"
          ? groups
          : [];
  const identities =
    context.identities === undefined || (identityUids.length === 0 && identityGids.length === 0)
      ? undefined
      : await resolveIdentityNames(context.identities, identityUids, identityGids);
  const user = identityLabel(identities?.users, credentials.uid);
  const group = identityLabel(identities?.groups, credentials.gid);
  const groupValues = groups.map((id) => identityLabel(identities?.groups, id));
  const output =
    selection === "user"
      ? names
        ? user
        : String(credentials.uid)
      : selection === "group"
        ? names
          ? group
          : String(credentials.gid)
        : selection === "groups"
          ? names
            ? groupValues.join(" ")
            : groups.join(" ")
          : `uid=${annotatedIdentity(credentials.uid, identities?.users)} gid=${annotatedIdentity(credentials.gid, identities?.groups)} groups=${groups
              .map((id) => annotatedIdentity(id, identities?.groups))
              .join(",")}`;
  await writeText(fds[1], `${output}\n`);
  return 0;
});

export const groupsCommand = /* @__PURE__ */ defineApplet(GROUPS, async (context, argv, fds) => {
  if (argv.length !== 0) throw appletUsageError(GROUPS, "user-name lookup is not supported");
  const { groups } = executionIdentity(context, GROUPS);
  const identities =
    context.identities === undefined
      ? undefined
      : await resolveIdentityNames(context.identities, [], groups);
  await writeText(
    fds[1],
    `${groups.map((id) => identityLabel(identities?.groups, id)).join(" ")}\n`,
  );
  return 0;
});
