import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { meterSqlStorage } from "./metered-sql.js";

it("meters the five POSIX optimization workloads", async () => {
  const rows = await runInDurableObject(env.VFS_TEST.getByName("perf-five"), async (_, state) => {
    const meter = meterSqlStorage(state.storage);
    const v = new DurableObjectFileSystem(meter.storage, { chunkBytes: 32768 });
    const f = createFsAdapter(v).promises;
    const rows: { name: string; statements: number; rowsRead: number; rowsWritten: number }[] = [];
    const sample = async (name: string, operation: () => Promise<unknown>) => {
      meter.reset();
      await operation();
      rows.push({
        name,
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      });
    };
    await f.writeFile("/a", new Uint8Array(8192).fill(65));
    const handle = await f.open("/a", "r+");
    await handle.stat();
    await sample("fstat", () => handle.stat());
    await sample("fd-read", () => handle.readFile());
    await f.unlink("/a");
    await sample("fstat-detached", () => handle.stat());
    const detached = await f.open("/detached", "w+");
    await detached.writeFile(new Uint8Array(8192).fill(65));
    const detachedReader = await f.open("/detached", "r");
    await f.unlink("/detached");
    await sample("fd-read-detached", () => detached.read(new Uint8Array(8192), 0, 8192, 0));
    await sample("fd-readfile-detached", () => detachedReader.readFile());
    await f.mkdir("/wide");
    for (let i = 0; i < 1000; i++) await f.mkdir(`/wide/d${i}`);
    await sample("create-wide", () => f.writeFile("/wide/a", "x"));
    await sample("rename-wide", () => f.rename("/wide/a", "/wide/b"));
    expect((await f.stat("/wide")).nlink).toBe(1002);
    for (const size of [1048576, 8388608]) {
      await f.writeFile(`/large${size}`, new Uint8Array(size).fill(65));
      const h = await f.open(`/large${size}`, "r+");
      await sample(`truncate-zero-${size}`, () => h.truncate(0));
      expect((await h.stat()).size).toBe(0);
      await h.close();
    }
    await f.writeFile("/boundary", new Uint8Array(1048576).fill(65));
    const boundary = await f.open("/boundary", "r+");
    await sample("truncate-boundary", () => boundary.truncate(32769));
    expect((await boundary.stat()).size).toBe(32769);
    await boundary.close();
    await f.writeFile("/write", new Uint8Array(1048576).fill(65));
    const write = await f.open("/write", "r+");
    await sample("write-full", () => write.write(new Uint8Array(1048576).fill(66), 0, 1048576, 0));
    await sample("write-byte", () => write.write("z", 0));
    expect((await f.readFile("/write"))[0]).toBe(122);
    await f.writeFile("/linked", "x");
    await f.link("/linked", "/alias");
    await f.writeFile("/unshared", "x");
    await sample("alias-chmod", () => f.chmod("/unshared", 0o600));
    await sample("alias-write", () => f.writeFile("/unshared", "y"));
    await sample("alias-shared-write", () => f.writeFile("/linked", "z"));
    expect(await f.readFile("/alias", "utf8")).toBe("z");
    await handle.close();
    await detached.close();
    await detachedReader.close();
    await write.close();
    return rows;
  });
  console.info(`POSIX PERF FIVE ${JSON.stringify(rows)}`);
  expect(rows.map((row) => [row.name, row.statements, row.rowsRead, row.rowsWritten])).toEqual([
    ["fstat", 1, 2, 0],
    ["fd-read", 3, 4, 0],
    ["fstat-detached", 2, 2, 0],
    ["fd-read-detached", 4, 4, 0],
    ["fd-readfile-detached", 4, 4, 0],
    ["create-wide", 8, 9, 6],
    ["rename-wide", 8, 8, 5],
    ["truncate-zero-1048576", 5, 2042, 34],
    ["truncate-zero-8388608", 5, 2268, 258],
    ["truncate-boundary", 7, 2046, 33],
    ["write-full", 35, 1041, 33],
    ["write-byte", 5, 1011, 2],
    ["alias-chmod", 3, 3, 1],
    ["alias-write", 3, 9, 2],
    ["alias-shared-write", 4, 1032, 5],
  ]);
});
