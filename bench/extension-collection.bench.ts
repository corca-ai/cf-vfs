import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  collectInlineBytes,
  collectInlineBytesSync,
  InFlightByteBudget,
} from "../src/vfs/buffering.js";

it("compares async string collection with owned encoded chunk views in workerd", async () => {
  const results = await runInDurableObject(
    env.VFS_TEST.getByName("extension-collection"),
    async () => {
      const results = [];
      for (const size of [8192, 1024 * 1024, 8 * 1024 * 1024]) {
        const body = "A".repeat(size);
        const budget = new InFlightByteBudget(32 * 1024 * 1024);
        const durations: number[][] = [[], []];
        const repetitions = size === 8192 ? 1000 : 50;
        for (let sample = -5; sample < 15; sample++) {
          for (const variant of sample % 2 === 0 ? [0, 1] : [1, 0]) {
            const start = Date.now();
            for (let repeat = 0; repeat < repetitions; repeat++) {
              const lease =
                variant === 0
                  ? await collectInlineBytes(body, 8 * 1024 * 1024, 256 * 1024, budget)
                  : collectInlineBytesSync(body, 8 * 1024 * 1024, 256 * 1024, budget);
              expect(lease.sizeBytes).toBe(size);
              expect(lease.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(size);
              expect(lease.chunks.at(-1)?.at(-1)).toBe(65);
              lease.release();
            }
            if (sample >= 0) durations[variant]?.push((Date.now() - start) / repetitions);
          }
        }
        results.push({
          size,
          repetitions,
          asyncMs: durations[0]?.toSorted((a, b) => a - b)[7],
          syncMs: durations[1]?.toSorted((a, b) => a - b)[7],
          rawMs: durations,
        });
      }
      return results;
    },
  );
  console.info(`EXTENSION COLLECTION ${JSON.stringify(results)}`);
  expect(results).toHaveLength(3);
});
