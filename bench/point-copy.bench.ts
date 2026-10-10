import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it.each([100, 1000])("bounds copying one file beside %i unrelated files", async (count) => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName(`point-copy-${count}`),
    async (_, state) => {
      const meter = meterSqlStorage(state.storage);
      const raw = new DurableObjectFileSystem(meter.storage, { recordChanges: true });
      raw.setMetadata("/", { mode: 0o40777 });
      const fs = raw.forCredentials({ uid: 1000, gid: 1000 });
      for (let index = 0; index < count; index++)
        await fs.writeFile(`/noise/f${index}`, "noise", { createParents: true });
      await fs.writeFile("/source", "source");
      await fs.writeFile("/target", "target");
      const source = fs.stat("/source");
      const target = fs.stat("/target");
      const cursor = raw.changesSince(0, { limit: 10000 }).cursor;
      meter.reset();
      const copied = await fs.copy("/source", "/target", { replace: true });
      const cost = {
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      };
      const sourceAfter = fs.stat("/source");
      const targetAfter = fs.stat("/target");
      return {
        ...cost,
        copied: copied.copied,
        sourceSame:
          sourceAfter.ino === source.ino && sourceAfter.mutationToken === source.mutationToken,
        targetSame: targetAfter.ino === target.ino,
        targetChanged: targetAfter.mutationToken !== target.mutationToken,
        changes: raw.changesSince(cursor).changes,
        body: await new Response(fs.readFile("/target").stream).text(),
      };
    },
  );
  console.info(`POINT COPY ${count} ${JSON.stringify(result)}`);
  expect(result).toMatchObject({
    copied: 1,
    sourceSame: true,
    targetSame: true,
    targetChanged: true,
    body: "source",
  });
  expect(result.changes).toEqual([
    { path: "/target", present: true },
    { path: "/", present: true },
  ]);
  expect(result.rowsRead).toBeLessThan(100);
});
