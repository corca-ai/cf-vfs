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
