import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it("keeps descriptor range costs independent of full file size", async () => {
  const rows = await runInDurableObject(
    env.VFS_TEST.getByName("descriptor-cost"),
    async (_, state) => {
      const meter = meterSqlStorage(state.storage);
      const v = new DurableObjectFileSystem(meter.storage, { chunkBytes: 32 * 1024 });
      const f = createFsAdapter(v).promises;
      const rows = [];
      for (const size of [32 * 1024, 8 * 1024 * 1024]) {
        await f.writeFile("/a", new Uint8Array(size).fill(65));
        const h = await f.open("/a", "r+");
        const out = new Uint8Array(1);
        await h.read(out, 0, 1, 0);
        meter.reset();
        await h.read(out, 0, 1, size - 1);
        const read = {
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        };
        meter.reset();
        await h.write("x", 0);
        const write = {
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        };
        rows.push({ size, read, write });
        await h.close();
      }
      return rows;
    },
  );
  console.info(`POSIX HANDLE COST ${JSON.stringify(rows)}`);
  expect(rows[0]?.read.statements).toBe(rows[1]?.read.statements);
  expect(rows[0]?.write.statements).toBe(rows[1]?.write.statements);
  expect(rows[1]?.write.rowsWritten).toBeLessThan(10);
});
