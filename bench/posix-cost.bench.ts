import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it("records credential-bound stat and replacement rename costs", async () => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName("posix-cost"),
    async (_, state) => {
      const meter = meterSqlStorage(state.storage);
      const vfs = new DurableObjectFileSystem(meter.storage);
      const rows = [];
      for (const depth of [1, 16, 64]) {
        const directory = `/${Array(depth).fill("d").join("/")}`;
        vfs.mkdir(directory, true);
        const path = `${directory}/file`;
        await vfs.writeFile(path, "x");
        const view = vfs.forCredentials({ uid: 1001, gid: 1001 });
        for (let i = 0; i < 100; i++) view.stat(path);
        meter.reset();
        const start = performance.now();
        for (let i = 0; i < 500; i++) view.stat(path);
        rows.push({
          op: "stat",
          depth,
          ms: performance.now() - start,
          statements: meter.statements,
          rowsRead: meter.rowsRead,
        });
      }
      for (const bytes of [80, 1024 * 1024, 8 * 1024 * 1024]) {
        await vfs.writeFile("/source", new Uint8Array(bytes));
        await vfs.writeFile("/target", new Uint8Array(bytes));
        const ino = vfs.stat("/source").ino;
        meter.reset();
        await vfs.move("/source", "/target", { replace: true });
        const cost = {
          op: "rename-replace",
          bytes,
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        };
        if (vfs.stat("/target").ino !== ino) throw new Error("rename changed identity");
        rows.push(cost);
      }
      return rows;
    },
  );
  console.info(`POSIX COST ${JSON.stringify(result)}`);
  expect(result).toHaveLength(6);
  expect(result.map((row) => row.statements)).toEqual([500, 500, 500, 12, 12, 12]);
  expect(result.slice(0, 3).map((row) => row.rowsRead)).toEqual([500, 500, 500]);
});
