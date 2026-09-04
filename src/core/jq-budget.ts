import { VfsError } from "./errors.js";
import type { JsonValue } from "./json-value.js";

/** Structural port: the JSON evaluator never imports the shell. */
export interface JqBudget {
  readonly limits: { readonly maxBufferedBytes: number; readonly maxBufferedRecords: number };
  step(count?: number): void;
  buffered(bytes: number): () => void;
}

/** Bounds synchronous work and intermediate materialization, including discarded results. */
export class JqEvaluationBudget {
  private work = 0;
  private records = 0;
  private bytes = 0;
  private releaseHost: () => void = () => undefined;
  private readonly seen = new WeakSet<object>();
  private depth = 0;

  constructor(private readonly host?: JqBudget) {}

  step(count = 1): void {
    this.host?.step(count);
    this.work += count;
    if (this.work > 1_000_000) throw new VfsError("E2BIG", "jq: evaluation work limit exceeded");
  }

  enter(): void {
    this.step();
    this.depth += 1;
    if (this.depth > 128) throw new VfsError("E2BIG", "jq: evaluation nesting limit exceeded");
  }

  leave(): void {
    this.depth -= 1;
  }

  reserve(bytes: number, records = 0): void {
    this.step();
    this.records += records;
    this.bytes += bytes;
    if (
      !Number.isSafeInteger(this.bytes) ||
      this.bytes > (this.host?.limits.maxBufferedBytes ?? 16 * 1024 * 1024)
    ) {
      throw new VfsError("E2BIG", "jq: intermediate byte limit exceeded");
    }
    if (this.records > (this.host?.limits.maxBufferedRecords ?? 100_000)) {
      throw new VfsError("E2BIG", "jq: intermediate record limit exceeded");
    }
    if (this.host !== undefined && bytes > 0) {
      this.releaseHost();
      this.releaseHost = this.host.buffered(this.bytes);
    }
  }

  retain(value: JsonValue, depth = 0): void {
    this.step();
    if (depth > 128) throw new VfsError("E2BIG", "jq: JSON nesting limit exceeded");
    if (typeof value === "string") {
      this.reserve(value.length * 2);
      return;
    }
    if (value === null || typeof value !== "object" || this.seen.has(value)) return;
    this.seen.add(value);
    if (Array.isArray(value)) {
      this.reserve(value.length * 8, value.length);
      for (const item of value) this.retain(item, depth + 1);
    } else if (value instanceof Map) {
      this.reserve(value.size * 32, value.size);
      for (const [key, item] of value) {
        this.reserve(key.length * 2);
        this.retain(item, depth + 1);
      }
    }
  }

  collect(values: Iterable<JsonValue>): JsonValue[] {
    const result: JsonValue[] = [];
    this.seen.add(result);
    for (const value of values) {
      this.reserve(8, 1);
      this.retain(value);
      result.push(value);
    }
    return result;
  }

  release(): void {
    this.releaseHost();
  }
}
