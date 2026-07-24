export function firstCodePoint(value: string): number {
  return value.codePointAt(0) ?? 0;
}

export function codePointLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}
