import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it.each([100, 1000])("bounds parent lookup cost across %i appends", async (count) => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName(`append-cache-${count}`),
    async (_, state) => {
      const meter = meterSqlStorage(state.storage);
      const raw = new DurableObjectFileSystem(meter.storage);
      raw.setMetadata("/", { mode: 0o40777 });
      const fs = raw.forCredentials({ uid: 1000, gid: 1000 });
      for (let index = 0; index < count; index++)
        await fs.writeFile(`/a/f${index}`, "body", { createParents: true });
      await fs.readFile("/a/f0").stream.cancel();
      const before = fs.stat("/a/f0");
      meter.reset();
      for (let index = 0; index < count; index++) await fs.appendFile(`/a/f${index}`, "x");
      const cost = {
        statements: meter.statements,
        reads: meter.rowsRead,
        writes: meter.rowsWritten,
      };
      const after = fs.stat("/a/f0");
      for (let index = 0; index < count; index++)
        if ((await new Response(fs.readFile(`/a/f${index}`).stream).text()) !== "bodyx")
          throw new Error("append bytes changed");
      raw.setMetadata("/a", { mode: 0o40000 });
      let denied = false;
      try {
        await fs.appendFile("/a/f0", "unsafe");
      } catch (error) {
        denied = error instanceof Error && "code" in error && error.code === "EACCES";
      }
      raw.setMetadata("/a", { mode: 0o40777 });
      return {
        ...cost,
        sameIdentity: before.ino === after.ino,
        changedToken: before.mutationToken !== after.mutationToken,
        denied,
        body: await new Response(fs.readFile("/a/f0").stream).text(),
      };
    },
  );
  console.log("append cache cost", count, result);
  expect(result.sameIdentity).toBe(true);
  expect(result.changedToken).toBe(true);
  expect(result.denied).toBe(true);
  expect(result.body).toBe("bodyx");
  expect(result.statements).toBeLessThanOrEqual(6 * count);
  expect(result.reads).toBeLessThanOrEqual(7 * count);
  expect(result.writes).toBe(3 * count);
});
