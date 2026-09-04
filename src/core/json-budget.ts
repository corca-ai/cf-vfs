import { VfsError } from "./errors.js";
import type { JsonValue } from "./json-value.js";

/** Structural work/allocation port shared by JSON parsing and evaluation. */
export interface JsonBudget {
  step(count?: number): void;
  reserve(bytes: number, records?: number): void;
}

/** Walk every occurrence: shared subtrees expand again when rendered as JSON. */
export function reserveJsonOutput(
  value: JsonValue,
  budget: JsonBudget,
  indent = 0,
  depth = 0,
): void {
  budget.step();
  if (depth > 128) throw new VfsError("E2BIG", "jq: JSON nesting limit exceeded");
  budget.reserve(typeof value === "string" ? value.length * 12 + 4 : 32);
  if (Array.isArray(value)) {
    budget.reserve(value.length * (8 + (depth + 1) * indent * 2), value.length);
    for (const item of value) reserveJsonOutput(item, budget, indent, depth + 1);
  } else if (value instanceof Map) {
    budget.reserve(value.size * (32 + (depth + 1) * indent * 2), value.size);
    for (const [key, item] of value) {
      budget.reserve(key.length * 12);
      reserveJsonOutput(item, budget, indent, depth + 1);
    }
  }
}
