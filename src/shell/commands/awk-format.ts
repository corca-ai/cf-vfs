import { VfsError } from "../../core/errors.js";
import {
  type AwkValue,
  asNumber,
  asString,
  generalNumber,
  inputValue,
  normalizeExponent,
} from "./awk-runtime.js";

const CONVERSION = /^([-+ 0]*)([0-9]*)(?:\.([0-9]+))?([scdiufegEGoxX])/u;

interface FormatConversion {
  length: number;
  flags: string;
  width: number;
  precision: number | undefined;
  specifier: string;
}

class BoundedFormatOutput {
  private value = "";

  constructor(private readonly maximumCharacters: number) {}

  append(value: string): void {
    if (this.value.length + value.length > this.maximumCharacters) {
      throw new VfsError("E2BIG", "awk: printf output exceeds the execution limit");
    }
    this.value += value;
  }

  result(): string {
    return this.value;
  }
}

function parseConversion(format: string, index: number, maximum: number): FormatConversion {
  const match = CONVERSION.exec(format.slice(index + 1));
  if (match === null) {
    throw new VfsError("EINVAL", `awk: unsupported printf conversion %${format[index + 1] ?? ""}`);
  }
  const width = Number(match[2] ?? "0");
  const precision = match[3] === undefined ? undefined : Number(match[3]);
  if (width > maximum || (precision ?? 0) > maximum) {
    throw new VfsError("E2BIG", "awk: printf field exceeds the execution limit");
  }
  return {
    length: match[0].length,
    flags: match[1] ?? "",
    width,
    precision,
    specifier: match[4] ?? "s",
  };
}

function pad(value: string, width: number, left: boolean, zero: boolean): string {
  const missing = Math.max(0, width - value.length);
  if (missing === 0) return value;
  const padding = (zero ? "0" : " ").repeat(missing);
  if (left) return value + padding;
  if (zero && /^[+-]/u.test(value)) return `${value[0]}${padding}${value.slice(1)}`;
  return padding + value;
}

function signedPrefix(value: number, flags: string): string {
  if (value < 0) return "-";
  if (flags.includes("+")) return "+";
  return flags.includes(" ") ? " " : "";
}

function nonnegativePrefix(value: number, flags: string): string {
  return value >= 0 ? signedPrefix(value, flags) : "";
}

function renderInteger(value: AwkValue, conversion: FormatConversion): string {
  let integer = Math.trunc(asNumber(value));
  if (conversion.specifier === "u") integer >>>= 0;
  const radix =
    conversion.specifier === "o"
      ? 8
      : conversion.specifier === "x" || conversion.specifier === "X"
        ? 16
        : 10;
  let rendered = Math.abs(integer).toString(radix);
  if (conversion.specifier === "X") rendered = rendered.toUpperCase();
  if (conversion.precision !== undefined) rendered = rendered.padStart(conversion.precision, "0");
  return signedPrefix(integer, conversion.flags) + rendered;
}

function floatDigits(specifier: string, precision: number | undefined): number {
  const digits =
    specifier === "g" || specifier === "G" ? Math.max(1, precision ?? 6) : (precision ?? 6);
  if (digits > 100) {
    throw new VfsError("E2BIG", "awk: floating-point precision exceeds the execution limit");
  }
  return digits;
}

function renderFloat(value: AwkValue, conversion: FormatConversion): string {
  const number = asNumber(value);
  const digits = floatDigits(conversion.specifier, conversion.precision);
  let rendered: string;
  if (conversion.specifier === "f") rendered = number.toFixed(digits);
  else if (conversion.specifier === "e" || conversion.specifier === "E") {
    rendered = normalizeExponent(number.toExponential(digits));
  } else rendered = generalNumber(number, digits);
  if (conversion.specifier === "E" || conversion.specifier === "G")
    rendered = rendered.toUpperCase();
  return nonnegativePrefix(number, conversion.flags) + rendered;
}

function renderValue(value: AwkValue, conversion: FormatConversion): string {
  if (conversion.specifier === "s") {
    const points = [...asString(value)];
    return conversion.precision === undefined
      ? points.join("")
      : points.slice(0, conversion.precision).join("");
  }
  if (conversion.specifier === "c") {
    return typeof value === "number"
      ? String.fromCodePoint(Math.trunc(value))
      : ([...asString(value)][0] ?? "");
  }
  if (/^[diuoxX]$/u.test(conversion.specifier)) return renderInteger(value, conversion);
  return renderFloat(value, conversion);
}

/** The common AWK printf core: bounded conversions, literal widths, no host locale. */
export function formatAwk(
  format: string,
  values: readonly AwkValue[],
  maximumCharacters: number,
): string {
  const output = new BoundedFormatOutput(maximumCharacters);
  let valueIndex = 0;
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index] ?? "";
    if (character !== "%") output.append(character);
    else if (format[index + 1] === "%") {
      output.append("%");
      index += 1;
    } else {
      const conversion = parseConversion(format, index, maximumCharacters);
      index += conversion.length;
      const rendered = renderValue(values[valueIndex++] ?? inputValue(""), conversion);
      output.append(
        pad(
          rendered,
          conversion.width,
          conversion.flags.includes("-"),
          conversion.flags.includes("0"),
        ),
      );
    }
  }
  return output.result();
}
