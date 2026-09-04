import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import type { AwkRuntimeState, AwkValue } from "./awk-runtime.js";

export function checkAwkString(state: AwkRuntimeState, value: AwkValue): AwkValue {
  if (typeof value === "number") return value;
  if (value.value.length > state.context.budget.limits.maxExpansionChars)
    throw new VfsError("E2BIG", "awk: string expansion limit exceeded");
  if (utf8ByteLength(value.value) > state.context.budget.limits.maxBufferedBytes)
    throw new VfsError("E2BIG", "awk: string byte limit exceeded");
  return value;
}

/** Check the result before join can allocate an amplified string. */
export function joinAwkStrings(
  state: AwkRuntimeState,
  values: readonly string[],
  separator = "",
): string {
  let length = Math.max(0, values.length - 1) * separator.length;
  for (const value of values) length += value.length;
  if (
    length > state.context.budget.limits.maxExpansionChars ||
    length > state.context.budget.limits.maxBufferedBytes
  )
    throw new VfsError("E2BIG", "awk: string expansion limit exceeded");
  state.context.budget.expansionWork(length);
  const result = values.join(separator);
  checkAwkString(state, { kind: "string", value: result, numeric: false });
  return result;
}

export function retainAwkVariable(state: AwkRuntimeState, name: string, value: AwkValue): void {
  checkAwkString(state, value);
  const bytes = typeof value === "number" ? 8 : utf8ByteLength(value.value);
  const total = state.scalarBytes + bytes - (state.scalarSizes.get(name) ?? 0);
  state.scalarRelease();
  state.scalarRelease = () => undefined;
  state.scalarRelease = state.context.budget.buffered(total);
  state.scalarSizes.set(name, bytes);
  state.scalarBytes = total;
}
