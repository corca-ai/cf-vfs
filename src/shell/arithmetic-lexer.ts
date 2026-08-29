import { VfsError } from "../core/errors.js";
import { utf8ByteLength } from "../core/unicode.js";

const OPERATORS = [
  "<<=",
  ">>=",
  "++",
  "--",
  "**",
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "^=",
  "|=",
  "=",
  "?",
  ":",
  ",",
  "(",
  ")",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "~",
  "<",
  ">",
  "&",
  "^",
  "|",
] as const;

export type ArithmeticOperator = (typeof OPERATORS)[number];

export type ArithmeticToken =
  | { type: "integer"; value: bigint; offset: number }
  | { type: "identifier"; value: string; offset: number }
  | { type: "operator"; value: ArithmeticOperator; offset: number }
  | { type: "end"; offset: number };

export class ArithmeticSyntaxError extends VfsError {
  readonly detail: string;
  readonly byteOffset: number;

  constructor(detail: string, source: string, offset: number) {
    const byteOffset = utf8ByteLength(source.slice(0, offset));
    super("EINVAL", `${detail} in arithmetic expression at byte ${byteOffset}`);
    this.detail = detail;
    this.byteOffset = byteOffset;
  }
}

export function arithmeticSyntax(
  message: string,
  source: string,
  offset: number,
): ArithmeticSyntaxError {
  return new ArithmeticSyntaxError(message, source, offset);
}

export function decimalOrOctalInteger(digits: string): bigint | undefined {
  if (digits.length > 1 && digits.startsWith("0")) {
    if (!/^[0-7]+$/u.test(digits)) return undefined;
    return BigInt(`0o${digits}`);
  }
  return BigInt(digits);
}

function integerToken(
  source: string,
  start: number,
): { readonly token: ArithmeticToken; readonly next: number } {
  if (source.startsWith("0x", start) || source.startsWith("0X", start)) {
    const digits = /^[0-9a-f]+/iu.exec(source.slice(start + 2))?.[0] ?? "";
    if (digits.length === 0) throw arithmeticSyntax("invalid hexadecimal literal", source, start);
    return {
      token: { type: "integer", value: BigInt(`0x${digits}`), offset: start },
      next: start + digits.length + 2,
    };
  }
  const digits = /^[0-9]+/u.exec(source.slice(start))?.[0] ?? "";
  const value = decimalOrOctalInteger(digits);
  if (value === undefined) throw arithmeticSyntax("invalid octal literal", source, start);
  return { token: { type: "integer", value, offset: start }, next: start + digits.length };
}

function variableToken(
  source: string,
  start: number,
): { readonly token: ArithmeticToken; readonly next: number } {
  if (source[start] !== "$") {
    const value = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(start))?.[0] ?? "";
    return { token: { type: "identifier", value, offset: start }, next: start + value.length };
  }
  if (source[start + 1] !== "{") {
    const value = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(start + 1))?.[0];
    if (value === undefined) throw arithmeticSyntax("invalid arithmetic variable", source, start);
    return { token: { type: "identifier", value, offset: start }, next: start + value.length + 1 };
  }
  const close = source.indexOf("}", start + 2);
  if (close < 0) throw arithmeticSyntax("unterminated variable reference", source, start);
  const value = source.slice(start + 2, close);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw arithmeticSyntax("invalid arithmetic variable", source, start);
  }
  return { token: { type: "identifier", value, offset: start }, next: close + 1 };
}

export function tokenizeArithmetic(source: string): ArithmeticToken[] {
  const tokens: ArithmeticToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset];
    if (character === undefined) break;
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const parsed = integerToken(source, offset);
      tokens.push(parsed.token);
      offset = parsed.next;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const parsed = variableToken(source, offset);
      tokens.push(parsed.token);
      offset = parsed.next;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, offset));
    if (operator === undefined) {
      throw arithmeticSyntax(`unexpected character ${JSON.stringify(character)}`, source, offset);
    }
    tokens.push({ type: "operator", value: operator, offset });
    offset += operator.length;
  }
  tokens.push({ type: "end", offset: source.length });
  return tokens;
}
