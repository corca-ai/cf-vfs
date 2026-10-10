import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it.each([100, 1000])("meters inode lookup beside %i unrelated files", async (count) => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName(`handles-scaling-${count}`),
    async (_, state) => {
      const meter = meterSqlStorage(state.storage);
      const fs = createFsAdapter(new DurableObjectFileSystem(meter.storage)).promises;
      for (let i = 0; i < count; i++) await fs.writeFile(`/noise${i}`, "noise");
      await fs.writeFile("/file", "original");
      const handle = await fs.open("/file", "r+");
      await handle.stat();
      meter.reset();
      const stat = await handle.stat();
      const plain = meter.rowsRead;
      await fs.link("/file", "/alias");
      await fs.unlink("/file");
      meter.reset();
      const linked = await handle.stat();
      const alias = meter.rowsRead;
      await handle.write("changed!", 0);
      expect(await fs.readFile("/alias", "utf8")).toBe("changed!");
      await fs.unlink("/alias");
      expect(await handle.readFile("utf8")).toBe("changed!");
      await handle.close();
      return { plain, alias, identity: linked.ino === stat.ino, links: linked.nlink };
    },
  );
  console.info(`HANDLE SCALING ${count} ${JSON.stringify(result)}`);
  expect(result).toMatchObject({ identity: true, links: 1 });
  expect(result.plain).toBeLessThan(20);
  expect(result.alias).toBeLessThan(20);
});
