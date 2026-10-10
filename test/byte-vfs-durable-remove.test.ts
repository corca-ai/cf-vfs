import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { meterSqlStorage } from "../bench/metered-sql.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { putOpaque } from "../src/vfs/opaque.js";

it.each([100, 1000])(
  "keeps single-file unlink cost independent of %i unrelated bodies",
  async (files) => {
    await runInDurableObject(
      env.VFS_TEST.getByName(`remove-cost-${files}`),
      async (_instance, state) => {
        const meter = meterSqlStorage(state.storage);
        const fs = new DurableObjectFileSystem(meter.storage);
        await fs.writeFile("/selected", "selected");
        fs.mkdir("/other");
        for (let offset = 0; offset < files; offset += 100) {
          await fs.writeFiles(
            Array.from({ length: Math.min(100, files - offset) }, (_, index) => ({
              path: `/other/f${offset + index}`,
              body: "body",
            })),
          );
        }
        meter.reset();
        expect((await fs.remove("/selected")).removed).toBe(1);
        expect(meter.statements).toBeGreaterThanOrEqual(5);
        expect(meter.statements).toBeLessThanOrEqual(10);
        expect(meter.rowsRead).toBeGreaterThanOrEqual(5);
        expect(meter.rowsRead).toBeLessThanOrEqual(40);
        expect(meter.rowsWritten).toBeGreaterThanOrEqual(3);
        expect(meter.rowsWritten).toBeLessThanOrEqual(15);
        expect(fs.list("/other")).toHaveLength(files);
        expect(() => fs.stat("/selected")).toThrow();
      },
    );
  },
);

it.each([10, 100])(
  "keeps opaque unlink cost independent of %i unrelated objects",
  async (files) => {
    await runInDurableObject(
      env.VFS_TEST.getByName(`opaque-remove-cost-${files}`),
      async (_instance, state) => {
        const meter = meterSqlStorage(state.storage);
        const store = new MemoryOpaqueStore();
        const fs = new DurableObjectFileSystem(meter.storage, { opaqueStore: store });
        fs.mkdir("/other");
        await putOpaque(fs, store, "/selected", Uint8Array.of(1));
        for (let index = 0; index < files; index++)
          await putOpaque(fs, store, `/other/f${index}`, Uint8Array.of(2));
        meter.reset();
        const removed = await fs.remove("/selected");
        expect(removed).toEqual({ removed: 1, opaqueObjectsQueuedForDeletion: 1 });
        expect(meter.statements).toBeGreaterThanOrEqual(5);
        expect(meter.statements).toBeLessThanOrEqual(20);
        expect(meter.rowsRead).toBeGreaterThanOrEqual(5);
        expect(meter.rowsRead).toBeLessThanOrEqual(50);
        expect(meter.rowsWritten).toBeGreaterThanOrEqual(3);
        expect(meter.rowsWritten).toBeLessThanOrEqual(20);
        expect(fs.list("/other")).toHaveLength(files);
      },
    );
  },
);
