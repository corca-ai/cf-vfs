import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";

class TransactionalFileSystem extends DurableObjectFileSystem {
  transact<T>(callback: () => T): T {
    return this.transaction(callback);
  }
}

it("observes parent permissions across filesystem instances and rollback", async () => {
  await runInDurableObject(env.VFS_TEST.getByName("traversal-cache-shared"), async (_, state) => {
    await state.storage.deleteAll();
    const first = new TransactionalFileSystem(state.storage);
    const second = new DurableObjectFileSystem(state.storage);
    await first.writeFile("/dir/file", "body", { createParents: true });
    const user = first.forCredentials({ uid: 1000, gid: 1000 });
    await user.readFile("/dir/file").stream.cancel();
    second.setMetadata("/dir", { mode: 0o40000 });
    expect(() => user.readFile("/dir/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
    second.setMetadata("/dir", { mode: 0o40755 });
    await user.readFile("/dir/file").stream.cancel();
    expect(() =>
      first.transact(() => {
        second.setMetadata("/dir", { mode: 0o40000 });
        expect(() => user.stat("/dir/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
        throw new Error("rollback traversal changes");
      }),
    ).toThrow("rollback traversal changes");
    await user.readFile("/dir/file").stream.cancel();
    expect(first.stat("/dir").mode).toBe(0o40755);
  });
});

it("invalidates one-use batch metadata across owners and nested rollback", async () => {
  await runInDurableObject(env.VFS_TEST.getByName("stat-batch-shared"), async (_, state) => {
    await state.storage.deleteAll();
    const first = new TransactionalFileSystem(state.storage);
    const second = new DurableObjectFileSystem(state.storage);
    await first.writeFile("/file", "body");
    await first.writeFile("/other", "other");
    const user = first.forCredentials({ uid: 1000, gid: 1000 });
    const warm = () => user.statMany?.(["/file", "/other"]);
    warm();
    second.setMetadata("/file", { mode: 0o100600 });
    expect(() => user.readFile("/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
    second.setMetadata("/file", { mode: 0o100644 });
    warm();
    expect(() =>
      first.transact(() => {
        second.setMetadata("/file", { mode: 0o100000 });
        warm();
        expect(() => user.readFile("/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
        throw new Error("rollback batch metadata");
      }),
    ).toThrow("rollback batch metadata");
    expect(await new Response(user.readFile("/file").stream).text()).toBe("body");
    warm();
    await second.writeFile("/file", "new body");
    expect(await new Response(user.readFile("/file").stream).text()).toBe("new body");
  });
});
