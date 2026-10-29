/** The value field splitting uses when `IFS` is unset. */
const DEFAULT_IFS = " \t\n";

/**
 * The two kinds of `IFS` character. Whitespace separators collapse and are
 * ignored at either end; every other separator delimits exactly one field, so
 * two in a row delimit an empty one.
 */
export interface FieldSeparators {
  readonly whitespace: string;
  readonly other: string;
}

/** `undefined` when `IFS` is empty, which turns field splitting off. */
export function fieldSeparators(ifs: string | undefined): FieldSeparators | undefined {
  const value = ifs ?? DEFAULT_IFS;
  if (value === "") return undefined;
  let whitespace = "";
  let other = "";
  for (const character of value) {
    if (character === " " || character === "\t" || character === "\n") whitespace += character;
    else other += character;
  }
  return { whitespace, other };
}

/** The first character of `IFS`, which joins `"$*"`: a space when unset, nothing when empty. */
export function joiningSeparator(ifs: string | undefined): string {
  return ifs === undefined ? " " : ([...ifs][0] ?? "");
}

/**
 * Text, or a field boundary. A `hard` boundary came from a non-whitespace
 * separator and ends a field even when nothing was in it.
 */
export type SplitToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "break"; readonly hard: boolean };

/** Splits one unquoted expansion result, keeping the boundaries at its ends. */
export function splitFields(value: string, separators: FieldSeparators): SplitToken[] {
  const tokens: SplitToken[] = [];
  const whitespace = (index: number): boolean =>
    index < value.length && separators.whitespace.includes(value[index] ?? "");
  const other = (index: number): boolean =>
    index < value.length && separators.other.includes(value[index] ?? "");
  let index = 0;
  while (index < value.length) {
    const start = index;
    while (index < value.length && !whitespace(index) && !other(index)) index += 1;
    if (index > start) tokens.push({ kind: "text", value: value.slice(start, index) });
    if (index >= value.length) break;
    // Whitespace around one other separator belongs to that one boundary.
    while (whitespace(index)) index += 1;
    const hard = other(index);
    if (hard) {
      index += 1;
      while (whitespace(index)) index += 1;
    }
    tokens.push({ kind: "break", hard });
  }
  return tokens;
}
