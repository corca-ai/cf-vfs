import { expect, it } from "vitest";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("reuses directory metadata across appends while checking each principal", async () => {
  let traversals = 0;
  const vfs = createTestFileSystem({
    onStatement: (sql) => {
      if (sql.includes("SELECT path, kind, mode, uid, gid")) traversals++;
    },
  });
  await vfs.writeFile("/a/file", "body", { createParents: true });
  vfs.setOwnership("/a", { uid: 1000, gid: 1000 });
  vfs.setMetadata("/a", { mode: 0o40700 });
  vfs.setMetadata("/a/file", { mode: 0o100666 });
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  await user.readFile("/a/file").stream.cancel();
  traversals = 0;
  await user.appendFile("/a/file", "1");
  await user.appendFile("/a/file", "2");
  expect(traversals).toBe(0);
  const outsider = vfs.forCredentials({ uid: 900, gid: 900 });
  await expect(outsider.appendFile("/a/file", "unsafe")).rejects.toMatchObject({ code: "EACCES" });
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("body12");
});

it("checks changed directory permissions after an append body yields", async () => {
  const vfs = createTestFileSystem();
  await vfs.writeFile("/a/file", "body", { createParents: true });
  vfs.setMetadata("/a/file", { mode: 0o100666 });
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (value) => {
      controller = value;
    },
  });
  const append = user.appendFile("/a/file", stream);
  vfs.setMetadata("/a", { mode: 0o40000 });
  controller?.enqueue(new TextEncoder().encode("unsafe"));
  controller?.close();
  await expect(append).rejects.toMatchObject({ code: "EACCES" });
  vfs.setMetadata("/a", { mode: 0o40777 });
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("body");
});

it("discards directory metadata observed during a nested mutation that rolls back", async () => {
  let inject: (() => void) | undefined;
  const vfs = createTestFileSystem({
    onStatement: (sql) => {
      if (inject !== undefined && sql.includes("UPDATE vfs_entries SET size_bytes")) {
        const callback = inject;
        inject = undefined;
        callback();
      }
    },
  });
  await vfs.writeFile("/a/file", "body", { createParents: true });
  vfs.setMetadata("/a/file", { mode: 0o100666 });
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  const root = vfs.forCredentials({ uid: 0, gid: 0 });
  await user.readFile("/a/file").stream.cancel();
  inject = () => {
    vfs.setMetadata("/a", { mode: 0o40000 });
    root.stat("/a/file");
    expect(() => user.stat("/a/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
    throw new Error("rollback append");
  };
  await expect(user.appendFile("/a/file", "unsafe")).rejects.toThrow("rollback append");
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("body");
  await user.appendFile("/a/file", "safe");
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("bodysafe");
});
