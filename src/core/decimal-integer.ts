export interface NormalizedDecimalInteger {
  readonly negative: boolean;
  readonly digits: string;
}

export function normalizeDecimalInteger(value: string): NormalizedDecimalInteger | undefined {
  if (!/^-?[0-9]+$/u.test(value)) return undefined;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const digits = unsigned.replace(/^0+/u, "") || "0";
  return { negative: negative && digits !== "0", digits };
}

export function compareDecimalIntegers(
  left: NormalizedDecimalInteger,
  right: NormalizedDecimalInteger,
): number {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  let order = left.digits.length - right.digits.length;
  if (order === 0 && left.digits !== right.digits) order = left.digits < right.digits ? -1 : 1;
  return left.negative ? -order : order;
}
