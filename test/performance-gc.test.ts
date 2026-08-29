import { describe, expect, it } from "vitest";
import { garbageStatements } from "./helpers/performance.js";

describe("garbage-collection SQL cost", () => {
  it("keeps successful cleanup constant across a full batch", async () => {
    const one = await garbageStatements(1);
    expect(one).toBeGreaterThan(0);
    expect(await garbageStatements(100)).toBe(one);
  });

  it("keeps failed backoff updates constant across a full batch", async () => {
    const one = await garbageStatements(1, { failDelete: true });
    expect(one).toBeGreaterThan(0);
    expect(await garbageStatements(100, { failDelete: true })).toBe(one);
  });

  it("expires each upload without re-reading its session", async () => {
    const one = await garbageStatements(1, { expireUploads: true });
    expect(one).toBeGreaterThan(0);
    expect(await garbageStatements(100, { expireUploads: true })).toBeLessThanOrEqual(one + 2 * 99);
  });
});
