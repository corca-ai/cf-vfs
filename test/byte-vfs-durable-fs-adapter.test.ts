import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { TieredFileContent } from "../src/fs/content.js";
import { createFsAdapter } from "../src/fs/index.js";
import { FsMetadataCache } from "../src/fs/metadata.js";
import { R2OpaqueStore } from "../src/storage/r2.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes } from "../src/vfs/streams.js";

it("supports large fs bodies and ranges with actual SQLite/R2 bindings", async () => {
  const stub = env.VFS_TEST.getByName("fs-tiered-large");
  const result = await runInDurableObject(stub, async (_instance, state) => {
    const store = new R2OpaqueStore(env.VFS_TEST_BUCKET);
    const cache = new FsMetadataCache();
    const vfs = new DurableObjectFileSystem(state.storage, {
      opaqueStore: store,
      onEvent: cache.onEvent,
    });
    const content = new TieredFileContent(vfs, store);
    const fs = createFsAdapter(vfs, {
      content,
      metadataCache: cache,
      maxReadFileBytes: 16 * 1024 * 1024,
    }).promises;
    const body = new Uint8Array(9 * 1024 * 1024).fill(7);
    body[body.length - 1] = 9;
    await fs.writeFile("/large", body);
    await fs.readdir("/");
    const stat = await fs.stat("/large");
    const read = await fs.readFile("/large");
    const suffix = await content.open("/large", { suffix: 2 });
    const ranged = await readAllBytes(suffix.stream, 2);
    await fs.writeFile("/large", "small");
    return {
      size: stat.size,
      kind: vfs.stat("/large").contentClass,
      last: read instanceof Uint8Array ? read.at(-1) : null,
      ranged: [...ranged],
      after: (await fs.stat("/large")).size,
    };
  });
  expect(result).toEqual({
    size: 9 * 1024 * 1024,
    kind: "inline",
    last: 9,
    ranged: [7, 9],
    after: 5,
  });
});

it("reduces billed metadata rows without changing the default VFS read path", async () => {
  const stub = env.VFS_TEST.getByName("fs-metadata-meter");
  const result = await runInDurableObject(stub, async (_instance, state) => {
    const { meterSqlStorage } = await import("../bench/metered-sql.js");
    const meter = meterSqlStorage(state.storage);
    const cache = new FsMetadataCache();
    const vfs = new DurableObjectFileSystem(meter.storage, { onEvent: cache.onEvent });
    vfs.mkdir("/dir");
    await vfs.writeFiles(
      Array.from({ length: 100 }, (_, i) => ({ path: `/dir/f${i}`, body: "x" })),
    );
    meter.reset();
    for (const entry of vfs.list("/dir")) {
      vfs.lstat(entry.path);
      vfs.lstat(entry.path);
    }
    const baseline = { statements: meter.statements, rowsRead: meter.rowsRead };
    meter.reset();
    for (const entry of cache.list(vfs, "/dir")) {
      cache.stat(vfs, entry.path, false);
      cache.stat(vfs, entry.path, false);
    }
    return { baseline, cached: { statements: meter.statements, rowsRead: meter.rowsRead } };
  });
  expect(result).toEqual({
    baseline: { statements: 202, rowsRead: 301 },
    cached: { statements: 2, rowsRead: 101 },
  });
});
