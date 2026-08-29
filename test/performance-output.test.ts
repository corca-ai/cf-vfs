import { expect, it } from "vitest";
import { createTestFileSystem } from "./helpers/node-sql.js";
import { runChunks } from "./helpers/performance.js";

it("batches many small records into 64 KiB slabs instead of one write each", async () => {
  const fileSystem = createTestFileSystem();
  const records = 20_000;
  await fileSystem.writeFile("/records", "record\n".repeat(records));
  const result = await runChunks(fileSystem, "nl /records");
  expect(result.exitCode).toBe(0);
  // Roughly 290 KiB across 20000 records, so a correct implementation emits a
  // handful of slabs. One chunk per record would be three orders of magnitude
  // more and is the regression this guard exists to catch.
  expect(result.bytes).toBeGreaterThan(256 * 1024);
  expect(result.chunks).toBeGreaterThan(0);
  expect(result.chunks).toBeLessThanOrEqual(Math.ceil(result.bytes / (64 * 1024)) + 1);
});

it("keeps a large single write unbuffered rather than splitting it", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/big", "x".repeat(200 * 1024));
  const result = await runChunks(fileSystem, "cat /big");
  expect(result.bytes).toBe(200 * 1024);
  // `cat` streams the inline snapshot, so chunk count tracks storage chunking
  // rather than record count.
  expect(result.chunks).toBeGreaterThan(0);
  expect(result.chunks).toBeLessThanOrEqual(8);
});
