/** Narrows a string against a canonical tuple of supported spellings. */
export function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return values.some((candidate) => candidate === value);
}
