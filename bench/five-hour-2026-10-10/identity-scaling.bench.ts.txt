import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it.each([100, 1000])("bounds identity lookup beside %i unrelated files", async (count) => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName(`identity-${count}`),
    async (_, state) => {
      const meter = meterSqlStorage(state.storage);
      const fs = new DurableObjectFileSystem(meter.storage);
      for (let index = 0; index < count; index++) await fs.writeFile(`/noise${index}`, "noise");
      await fs.writeFile("/file", "original");
      const original = fs.stat("/file");
      meter.reset();
      const stat = fs.statById(original.ino);
      const plain = meter.rowsRead;
      await createFsAdapter(fs).promises.link("/file", "/alias");
      await fs.remove("/file");
      meter.reset();
      const alias = fs.statById(original.ino);
      const linked = meter.rowsRead;
      await fs.remove("/alias");
      let missing = false;
      try {
        fs.statById(original.ino);
      } catch (error) {
        missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      }
      return {
        plain,
        linked,
        statIdentity: stat.ino,
        aliasIdentity: alias.ino,
        expectedIdentity: original.ino,
        missing,
      };
    },
  );
  console.log("identity scaling", count, result);
  expect(result.statIdentity).toBe(result.expectedIdentity);
  expect(result.aliasIdentity).toBe(result.expectedIdentity);
  expect(result.missing).toBe(true);
  expect(result.plain).toBeLessThan(10);
  expect(result.linked).toBeLessThan(10);
});
