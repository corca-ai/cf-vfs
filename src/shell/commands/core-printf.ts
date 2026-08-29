import { VfsError } from "../../core/errors.js";
import { type AppletSpec, appletUsageError, defineApplet } from "./applet.js";
import { writeText } from "./helpers.js";

const PRINTF = {
  name: "printf",
  usage: "FORMAT [ARGUMENT...]",
  summary: "formats strings, characters, and integers with POSIX-style conversions",
  kind: "builtin",
} as const satisfies AppletSpec;

const MIN_INTEGER = -(1n << 63n);
const MAX_INTEGER = (1n << 63n) - 1n;
const MAX_UNSIGNED_INTEGER = (1n << 64n) - 1n;
const CONVERSION = /^([-+ #0]*)(\*|[0-9]*)(?:\.(\*|[0-9]*))?([A-Za-z%])/u;

interface PrintfResult {
  output: string;
  diagnostics: string[];
}

interface ParsedInteger {
  value: bigint;
  diagnostic?: string;
}

interface Conversion {
  length: number;
  flags: string;
  widthToken: string;
  precisionToken: string | undefined;
  specifier: string;
}

interface ResolvedConversion {
  flags: string;
  width: number | undefined;
  precision: number | undefined;
  specifier: string;
}

class PrintfOutput {
  private value = "";
  readonly diagnostics: string[] = [];

  constructor(private readonly maximumCharacters: number) {}

  append(value: string): void {
    if (this.value.length + value.length > this.maximumCharacters) {
      throw new VfsError("E2BIG", "printf output exceeds the execution limit");
    }
    this.value += value;
  }

  diagnose(diagnostic: string | undefined): void {
    if (diagnostic !== undefined) this.diagnostics.push(diagnostic);
  }

  result(): PrintfResult {
    return { output: this.value, diagnostics: this.diagnostics };
  }
}

function parseConversion(format: string, offset: number): Conversion {
  const match = CONVERSION.exec(format.slice(offset + 1));
  if (match === null) {
    throw appletUsageError(PRINTF, `unsupported conversion %${format[offset + 1] ?? ""}`);
  }
  return {
    length: match[0].length,
    flags: match[1] ?? "",
    widthToken: match[2] ?? "",
    precisionToken: match[3],
    specifier: match[4] ?? "",
  };
}

function parseFieldSize(
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

function parseDynamicField(
  input: string,
  label: string,
  maximum: number,
  negativeIsOmitted: boolean,
): { value: number | undefined; left: boolean; diagnostic?: string } {
  const parsed = parseIntegerValue(input);
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

function resolveConversion(
  conversion: Conversion,
  values: readonly string[],
  index: number,
  maximum: number,
  output: PrintfOutput,
): { conversion: ResolvedConversion; consumed: number } {
  let consumed = 0;
  let flags = conversion.flags;
  let width =
    conversion.widthToken === "*"
      ? undefined
      : parseFieldSize(conversion.widthToken, "field width", maximum);
  if (conversion.widthToken === "*") {
    const field = parseDynamicField(values[index + consumed] ?? "0", "field width", maximum, false);
    consumed += 1;
    width = field.value;
    if (field.left) flags += "-";
    output.diagnose(field.diagnostic);
  }
  let precision =
    conversion.precisionToken === undefined || conversion.precisionToken === "*"
      ? undefined
      : parseFieldSize(conversion.precisionToken, "precision", maximum, 0);
  if (conversion.precisionToken === "*") {
    const field = parseDynamicField(values[index + consumed] ?? "0", "precision", maximum, true);
    consumed += 1;
    precision = field.value;
    output.diagnose(field.diagnostic);
  }
  return {
    conversion: { flags, width, precision, specifier: conversion.specifier },
    consumed,
  };
}

function assertFlags(flags: string, supported: string): void {
  for (const flag of flags) {
    if (!supported.includes(flag)) throw appletUsageError(PRINTF, `unsupported flag ${flag}`);
  }
}

function formatText(
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

function integerPrefix(value: bigint, specifier: string, flags: string, digits: string): string {
  const signed = specifier === "d" || specifier === "i";
  if (signed && value < 0) return "-";
  if (signed && flags.includes("+")) return "+";
  if (signed && flags.includes(" ")) return " ";
  if (flags.includes("#") && specifier === "o" && !digits.startsWith("0")) return "0";
  if (flags.includes("#") && value !== 0n && (specifier === "x" || specifier === "X")) {
    return specifier === "x" ? "0x" : "0X";
  }
  return "";
}

function formatIntegerDigits(
  magnitude: bigint,
  specifier: string,
  precision: number | undefined,
): string {
  const radix = specifier === "o" ? 8 : specifier === "x" || specifier === "X" ? 16 : 10;
  let digits = magnitude.toString(radix);
  if (specifier === "X") digits = digits.toUpperCase();
  if (precision === 0 && magnitude === 0n) return "";
  return precision === undefined ? digits : digits.padStart(precision, "0");
}

function formatInteger(
  value: bigint,
  specifier: string,
  flags: string,
  width: number | undefined,
  precision: number | undefined,
): string {
  const signed = specifier === "d" || specifier === "i";
  const magnitude = signed ? (value < 0 ? -value : value) : BigInt.asUintN(64, value);
  const digits = formatIntegerDigits(magnitude, specifier, precision);
  const prefix = integerPrefix(value, specifier, flags, digits);
  const padding = Math.max(0, (width ?? 0) - prefix.length - digits.length);
  if (flags.includes("-")) return prefix + digits + " ".repeat(padding);
  if (flags.includes("0") && precision === undefined) return prefix + "0".repeat(padding) + digits;
  return " ".repeat(padding) + prefix + digits;
}

function integerDigits(input: string): { digits: string; consumed: number; radix: 8 | 10 | 16 } {
  if (/^0[xX]/u.test(input)) {
    const digits = /^[0-9a-f]+/iu.exec(input.slice(2))?.[0] ?? "";
    return { digits, consumed: 2 + digits.length, radix: 16 };
  }
  if (input.startsWith("0")) {
    const digits = /^0[0-7]*/u.exec(input)?.[0] ?? "";
    return { digits, consumed: digits.length, radix: 8 };
  }
  const digits = /^[0-9]+/u.exec(input)?.[0] ?? "";
  return { digits, consumed: digits.length, radix: 10 };
}

function digitsValue(digits: string, radix: 8 | 10 | 16): bigint {
  if (digits.length === 0) return 0n;
  if (radix === 16) return BigInt(`0x${digits}`);
  if (radix === 8) return BigInt(`0o${digits}`);
  return BigInt(digits);
}

function invalidIntegerDiagnostic(
  original: string,
  digits: string,
  radix: 8 | 10 | 16,
  remaining: string,
): string | undefined {
  if (digits.length > 0 && remaining.length === 0) return undefined;
  const message =
    radix === 8 && /^[89]/u.test(remaining) ? "invalid octal number" : "invalid number";
  return `printf: ${original}: ${message}\n`;
}

function parseIntegerValue(inputValue: string, unsigned = false): ParsedInteger {
  if (inputValue.startsWith("'") || inputValue.startsWith('"')) {
    const character = [...inputValue.slice(1)][0];
    if (character !== undefined) return { value: BigInt(character.codePointAt(0) ?? 0) };
  }
  const input = inputValue.trimStart();
  const negative = input.startsWith("-");
  const magnitudeInput = negative || input.startsWith("+") ? input.slice(1) : input;
  const parsedDigits = integerDigits(magnitudeInput);
  let value = digitsValue(parsedDigits.digits, parsedDigits.radix) * (negative ? -1n : 1n);
  let diagnostic = invalidIntegerDiagnostic(
    inputValue,
    parsedDigits.digits,
    parsedDigits.radix,
    magnitudeInput.slice(parsedDigits.consumed),
  );
  const maximum = unsigned ? MAX_UNSIGNED_INTEGER : MAX_INTEGER;
  if (value < MIN_INTEGER || value > maximum) {
    value = value < MIN_INTEGER ? MIN_INTEGER : maximum;
    diagnostic = `printf: ${inputValue}: Result not representable\n`;
  }
  return { value, ...(diagnostic === undefined ? {} : { diagnostic }) };
}

function decodeEscapes(value: string): string {
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

function renderTextConversion(
  conversion: ResolvedConversion,
  argument: string,
): { output: string } {
  const { flags, width, precision, specifier } = conversion;
  assertFlags(flags, "-");
  if (specifier === "c" && precision !== undefined) {
    throw appletUsageError(PRINTF, "precision does not apply to %c");
  }
  const value =
    specifier === "b"
      ? decodeEscapes(argument)
      : specifier === "c"
        ? ([...argument][0] ?? "")
        : argument;
  return { output: formatText(value, width, precision, flags.includes("-")) };
}

function renderIntegerConversion(
  conversion: ResolvedConversion,
  argument: string,
): { output: string; diagnostic?: string } {
  const { flags, width, precision, specifier } = conversion;
  const signed = specifier === "d" || specifier === "i";
  assertFlags(flags, signed ? "-+ 0" : specifier === "u" ? "-0" : "-#0");
  const parsed = parseIntegerValue(argument, !signed);
  return {
    output: formatInteger(parsed.value, specifier, flags, width, precision),
    ...(parsed.diagnostic === undefined ? {} : { diagnostic: parsed.diagnostic }),
  };
}

function renderConversion(
  conversion: ResolvedConversion,
  argument: string,
): { output: string; diagnostic?: string } {
  const { flags, width, precision, specifier } = conversion;
  if (specifier === "%") {
    if (flags !== "" || width !== undefined || precision !== undefined) {
      throw appletUsageError(PRINTF, "flags, width, and precision do not apply to %%");
    }
    return { output: "%" };
  }
  if (specifier === "s" || specifier === "b" || specifier === "c") {
    return renderTextConversion(conversion, argument);
  }
  if (!/^[diouxX]$/u.test(specifier)) {
    throw appletUsageError(PRINTF, `unsupported conversion %${specifier}`);
  }
  return renderIntegerConversion(conversion, argument);
}

function formatOnce(
  format: string,
  values: readonly string[],
  maximum: number,
): { result: PrintfResult; consumed: number } {
  const output = new PrintfOutput(maximum);
  let consumed = 0;
  for (let offset = 0; offset < format.length; offset += 1) {
    const character = format[offset];
    if (character === "\\") {
      output.append(decodeEscapes(format.slice(offset, offset + 2)));
      offset += 1;
    } else if (character !== "%") {
      output.append(character ?? "");
    } else {
      const parsed = parseConversion(format, offset);
      offset += parsed.length;
      const resolved = resolveConversion(parsed, values, consumed, maximum, output);
      consumed += resolved.consumed;
      const needsArgument = resolved.conversion.specifier !== "%";
      const rendered = renderConversion(resolved.conversion, values[consumed] ?? "");
      if (needsArgument) consumed += 1;
      output.append(rendered.output);
      output.diagnose(rendered.diagnostic);
    }
  }
  return { result: output.result(), consumed };
}

function formatPrintf(format: string, values: readonly string[], maximum: number): PrintfResult {
  const output = new PrintfOutput(maximum);
  let offset = 0;
  do {
    const formatted = formatOnce(format, values.slice(offset), maximum);
    output.append(formatted.result.output);
    for (const diagnostic of formatted.result.diagnostics) output.diagnose(diagnostic);
    offset += formatted.consumed;
    if (formatted.consumed === 0) break;
  } while (offset < values.length);
  return output.result();
}

export const printfCommand = /* @__PURE__ */ defineApplet(PRINTF, async (context, argv, fds) => {
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
