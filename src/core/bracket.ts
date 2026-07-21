export type BracketRange = readonly [start: number, end: number];

export interface BracketExpression {
  close: number;
  negated: boolean;
  ranges: BracketRange[];
}

interface BracketElement {
  value: string;
  escaped: boolean;
}

function codePoint(value: string): number {
  return value.codePointAt(0) ?? 0;
}

export function parseBracketExpression(
  characters: readonly string[],
  open: number,
): BracketExpression | undefined {
  let index = open + 1;
  let negated = false;
  if ((characters[index] === "!" || characters[index] === "^")
    && characters[index] !== undefined) {
    negated = true;
    index += 1;
  }

  const elements: BracketElement[] = [];
  if (characters[index] === "]") {
    elements.push({ value: "]", escaped: false });
    index += 1;
  }

  let close = -1;
  while (index < characters.length) {
    const value = characters[index] ?? "";
    if (value === "\\" && characters[index + 1] !== undefined) {
      elements.push({ value: characters[index + 1] ?? "", escaped: true });
      index += 2;
      continue;
    }
    if (value === "]") {
      close = index;
      break;
    }
    elements.push({ value, escaped: false });
    index += 1;
  }
  if (close < 0 || elements.length === 0) return undefined;

  const ranges: BracketRange[] = [];
  for (let offset = 0; offset < elements.length; offset += 1) {
    const start = elements[offset];
    const separator = elements[offset + 1];
    const end = elements[offset + 2];
    if (start !== undefined && separator?.value === "-" && !separator.escaped && end !== undefined) {
      const left = codePoint(start.value);
      const right = codePoint(end.value);
      if (left <= right) ranges.push([left, right]);
      offset += 2;
      continue;
    }
    if (start !== undefined) {
      const point = codePoint(start.value);
      ranges.push([point, point]);
    }
  }
  return { close, negated, ranges };
}
