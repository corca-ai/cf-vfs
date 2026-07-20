import { VfsError } from "./errors.js";

export type InputRecord = Readonly<Record<string, unknown>>;

function isInputRecord(value: unknown): value is InputRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function inputRecord(value: unknown): InputRecord {
  if (value === undefined) return {};
  if (!isInputRecord(value)) {
    throw new VfsError("EINVAL", "command input must be an object");
  }
  return value;
}

export function stringValue(
  record: InputRecord,
  key: string,
  fallback?: string,
): string {
  const value = record[key] ?? fallback;
  if (typeof value !== "string") {
    throw new VfsError("EINVAL", `${key} must be a string`);
  }
  return value;
}

export function optionalString(
  record: InputRecord,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new VfsError("EINVAL", `${key} must be a string`);
  }
  return value;
}

export function optionalStringChoice<const Choices extends readonly string[]>(
  record: InputRecord,
  key: string,
  choices: Choices,
): Choices[number] | undefined {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) {
    throw new VfsError("EINVAL", `${key} must be one of ${choices.join(", ")}`);
  }
  return choice;
}

export function booleanValue(
  record: InputRecord,
  key: string,
  fallback = false,
): boolean {
  const value = record[key] ?? fallback;
  if (typeof value !== "boolean") {
    throw new VfsError("EINVAL", `${key} must be a boolean`);
  }
  return value;
}

export function integerValue(
  record: InputRecord,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = record[key] ?? fallback;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new VfsError(
      "EINVAL",
      `${key} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

export function optionalInteger(
  record: InputRecord,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (record[key] === undefined) return undefined;
  return integerValue(record, key, minimum, minimum, maximum);
}

export function stringArray(
  record: InputRecord,
  key: string,
  fallback: readonly string[] = [],
): string[] {
  const value = record[key] ?? fallback;
  if (!Array.isArray(value)) {
    throw new VfsError("EINVAL", `${key} must be an array of strings`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new VfsError("EINVAL", `${key} must be an array of strings`);
    }
    strings.push(item);
  }
  return strings;
}
