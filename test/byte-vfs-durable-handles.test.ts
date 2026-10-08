import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { putOpaque } from "../src/vfs/opaque.js";

it("shares hardlinked open inodes through unlink with actual SQLite and storage sync", async () => {
  await runInDurableObject(env.VFS_TEST.getByName("durable-handles"), async (_, state) => {
    const v = new DurableObjectFileSystem(state.storage, { chunkBytes: 4 });
    const f = createFsAdapter(v).promises;
    await f.writeFile("/a", "12345678");
    await f.link("/a", "/b");
    const h = await f.open("/a", "r+");
    await f.unlink("/a");
    expect(await h.readFile("utf8")).toBe("12345678");
    await f.unlink("/b");
    await h.write("xy", 0);
    await h.sync();
    expect((await h.stat()).nlink).toBe(0);
    await h.close();
    expect(
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_detached_inodes")
        .one().count,
    ).toBe(0);
  });
});

it("recovers detached opaque inodes and schedules GC when no prior alarm remains", async () => {
  await runInDurableObject(env.VFS_TEST.getByName("detached-recovery"), async (_, state) => {
    let now = Date.now() + 100_000;
    const store = new MemoryOpaqueStore();
    const options = { opaqueStore: store, now: () => now, receiptRetentionMs: 1 };
    const old = new DurableObjectFileSystem(state.storage, options);
    await putOpaque(old, store, "/a", "body");
    now += 10;
    await old.drainGarbage();
    await state.storage.deleteAlarm();
    const h = await createFsAdapter(old).promises.open("/a", "r");
    await old.remove("/a");
    expect(await state.storage.getAlarm()).toBeNull();
    // Simulate owner eviction: its local handles are no longer used.
    void h;
    const recovered = new DurableObjectFileSystem(state.storage, options);
    await recovered.initialize();
    expect(await state.storage.getAlarm()).toBe(now);
    const drained = await recovered.drainGarbage();
    expect(drained.deleted).toBe(1);
  });
});
