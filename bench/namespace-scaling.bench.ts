import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it.each([100, 1000])("bounds credential-bound copy work for %i files", async (count) => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName(`copy-scaling-${count}`),
    async (_, state) => {
      const meter = meterSqlStorage(state.storage);
      const raw = new DurableObjectFileSystem(meter.storage);
      raw.setMetadata("/", { mode: 0o40777 });
      const fs = raw.forCredentials({ uid: 1000, gid: 1000 });
      for (let index = 0; index < count; index++)
        await fs.writeFile(`/source/nested/f${index}`, `file ${index}`, { createParents: true });
      const source = fs.stat("/source/nested/f0");
      meter.reset();
      const copied = await fs.copy("/source", "/copy", { recursive: true });
      const cost = {
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      };
      const target = fs.stat("/copy/nested/f0");
      return {
        ...cost,
        copied: copied.copied,
        uid: target.uid,
        mode: target.mode,
        newIdentity: target.ino !== source.ino,
        body: await new Response(fs.readFile("/copy/nested/f0").stream).text(),
        sourcePresent: fs.stat("/source/nested/f0").ino === source.ino,
      };
    },
  );
  console.info(`NAMESPACE COPY ${count} ${JSON.stringify(result)}`);
  expect(result).toMatchObject({
    copied: count + 2,
    uid: 1000,
    mode: 0o100644,
    newIdentity: true,
    body: "file 0",
    sourcePresent: true,
  });
  expect(result.rowsRead).toBeLessThan(40 * count + 100);
});

it.each([
  { count: 100, recordChanges: false },
  { count: 1000, recordChanges: false },
])(
  "bounds single-entry rename work: $count files, changes $recordChanges",
  async ({ count, recordChanges }) => {
    const result = await runInDurableObject(
      env.VFS_TEST.getByName(`rename-scaling-${count}-${recordChanges}`),
      async (_, state) => {
        const meter = meterSqlStorage(state.storage);
        const raw = new DurableObjectFileSystem(meter.storage, { recordChanges });
        raw.setMetadata("/", { mode: 0o40777 });
        const fs = raw.forCredentials({ uid: 1000, gid: 1000 });
        for (let index = 0; index < count; index++)
          await fs.writeFile(`/noise/f${index}`, "noise", { createParents: true });
        await fs.writeFile("/source", "source");
        await fs.writeFile("/target", "target");
        const source = fs.stat("/source");
        const target = fs.stat("/target");
        const cursor = recordChanges ? raw.changesSince(0, { limit: 10000 }).cursor : 0;
        meter.reset();
        const moved = await fs.move("/source", "/target", { replace: true });
        const cost = {
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        };
        return {
          ...cost,
          changes: recordChanges ? raw.changesSince(cursor).changes : [],
          moved: moved.moved,
          replaced: moved.replaced,
          sameIdentity: fs.stat("/target").ino === source.ino,
          sourceTokenChanged: fs.getMutationToken("/source") !== source.mutationToken,
          targetTokenChanged: fs.getMutationToken("/target") !== target.mutationToken,
          body: await new Response(fs.readFile("/target").stream).text(),
        };
      },
    );
    console.info(`NAMESPACE RENAME ${count} ${JSON.stringify(result)}`);
    expect(result).toMatchObject({
      moved: 1,
      replaced: true,
      sameIdentity: true,
      sourceTokenChanged: true,
      targetTokenChanged: true,
      body: "source",
    });
    if (recordChanges)
      expect(result.changes).toEqual([
        { path: "/source", present: false },
        { path: "/target", present: true },
        { path: "/", present: true },
      ]);
    expect(result.rowsRead).toBeLessThan(100);
  },
);
