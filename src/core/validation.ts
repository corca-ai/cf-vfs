import { VfsError } from "./errors.js";

export function inputRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VfsError("EINVAL", "command input must be an object");
  }
  return value as Record<string, unknown>;
}

export function stringValue(
  record: Record<string, unknown>,
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
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new VfsError("EINVAL", `${key} must be a string`);
  }
  return value;
}

export function booleanValue(
  record: Record<string, unknown>,
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
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = record[key] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new VfsError(
      "EINVAL",
      `${key} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

export function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (record[key] === undefined) return undefined;
  return integerValue(record, key, minimum, minimum, maximum);
}

export function stringArray(
  record: Record<string, unknown>,
  key: string,
  fallback: readonly string[] = [],
): string[] {
  const value = record[key] ?? fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new VfsError("EINVAL", `${key} must be an array of strings`);
  }
  return [...value];
}
