import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { meterSqlStorage } from "../bench/metered-sql.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

it("reads bodies in bulk with two statements per batch and no more rows than per-file reads", async () => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName("byte-read-many-cost"),
    async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fs = new DurableObjectFileSystem(meter.storage, { chunkBytes: 64 });
      const paths = Array.from({ length: 200 }, (_, index) => `/w/f${index}`);
      await fs.writeFiles(
        paths.map((path, index) => ({ path, body: `${path}\n`.repeat(1 + (index % 9)) })),
        { createParents: true },
      );
      meter.reset();
      const bodies = fs.readMany(paths);
      const bulk = { statements: meter.statements, reads: meter.rowsRead };
      meter.reset();
      const single: string[] = [];
      for (const path of paths) single.push(await new Response(fs.readFile(path).stream).text());
      const decoder = new TextDecoder();
      return {
        bulk,
        single: { statements: meter.statements, reads: meter.rowsRead },
        same: bodies.every(
          (read, index) => read && decoder.decode(joinBytes(read.chunks)) === single[index],
        ),
        capped: fs.readMany(paths, { maxBytes: 100 }).filter((read) => read !== undefined).length,
      };
    },
  );
  expect(result.same).toBe(true);
  expect(result.bulk.statements).toBe(8);
  expect(result.single.statements).toBeGreaterThanOrEqual(200);
  expect(result.bulk.reads).toBeLessThanOrEqual(result.single.reads);
  expect(result.capped).toBeGreaterThan(0);
  expect(result.capped).toBeLessThan(20);
});
