import { expect, it } from "vitest";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("retains traversal metadata across a read, edit, temporary-file cleanup and token check", async () => {
  let traversals = 0;
  const fs = createTestFileSystem({
    onStatement: (query) => {
      if (query.includes("SELECT path, kind, mode, uid, gid")) traversals++;
    },
  });
  fs.mkdir("/workspace");
  fs.setOwnership("/workspace", { uid: 1000, gid: 1000 });
  fs.setMetadata("/workspace", { mode: 0o40700 });
  const user = fs.forCredentials({ uid: 1000, gid: 1000 });
  await user.writeFile("/workspace/file", "before");
  await user.readFile("/workspace/file").stream.cancel();
  traversals = 0;
  const before = user.getMutationToken("/workspace/file");
  await user.writeFiles([
    { path: "/workspace/file", body: "after" },
    { path: "/workspace/temporary", body: "temporary" },
  ]);
  await user.remove("/workspace/temporary");
  expect(user.getMutationToken("/workspace/file")).not.toBe(before);
  expect(await new Response(user.readFile("/workspace/file").stream).text()).toBe("after");
  expect(traversals).toBe(0);
  const outsider = fs.forCredentials({ uid: 2000, gid: 2000 });
  expect(() => outsider.getMutationToken("/workspace/file")).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
  await expect(outsider.writeFile("/workspace/file", "unsafe")).rejects.toMatchObject({
    code: "EACCES",
  });
  await expect(outsider.remove("/workspace/file")).rejects.toMatchObject({ code: "EACCES" });
});

it.each([false, true])(
  "rechecks directory permission after streaming a write (batch %s)",
  async (batch) => {
    const fs = createTestFileSystem();
    await fs.writeFile("/a/file", "before", { createParents: true });
    fs.setMetadata("/a/file", { mode: 0o100666 });
    const user = fs.forCredentials({ uid: 1000, gid: 1000 });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const write = batch
      ? user.writeFiles([{ path: "/a/file", body }])
      : user.writeFile("/a/file", body);
    fs.setMetadata("/a", { mode: 0o40000 });
    controller.enqueue(new TextEncoder().encode("unsafe"));
    controller.close();
    await expect(write).rejects.toMatchObject({ code: "EACCES" });
    fs.setMetadata("/a", { mode: 0o40755 });
    expect(await new Response(user.readFile("/a/file").stream).text()).toBe("before");
  },
);

it("invalidates retained metadata for directory replacement and parent creation", async () => {
  const fs = createTestFileSystem();
  fs.setMetadata("/", { mode: 0o40777 });
  const user = fs.forCredentials({ uid: 1000, gid: 1000 });
  await user.writeFile("/a/b/file", "before", { createParents: true });
  user.getMutationToken("/a/b/file");
  await user.remove("/a/b", { recursive: true });
  await user.writeFile("/a/b", "regular file");
  await expect(user.writeFile("/a/b/file", "unsafe")).rejects.toMatchObject({ code: "ENOTDIR" });
  await user.remove("/a/b");
  await user.writeFiles([{ path: "/a/b/file", body: "after" }], { createParents: true });
  expect(await new Response(user.readFile("/a/b/file").stream).text()).toBe("after");
  fs.setOwnership("/a/b", { uid: 2000, gid: 2000 });
  fs.setMetadata("/a/b", { mode: 0o40700 });
  expect(() => user.getMutationToken("/a/b/file")).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
});

it("discards metadata from nested directory changes when a file write rolls back", async () => {
  let inject: (() => void) | undefined;
  const fs = createTestFileSystem({
    onStatement: (query) => {
      if (inject && query.includes("UPDATE vfs_entries SET")) {
        const callback = inject;
        inject = undefined;
        callback();
      }
    },
  });
  await fs.writeFile("/a/file", "before", { createParents: true });
  fs.setMetadata("/a/file", { mode: 0o100666 });
  const user = fs.forCredentials({ uid: 1000, gid: 1000 });
  user.stat("/a/file");
  inject = () => {
    fs.setMetadata("/a", { mode: 0o40000 });
    expect(() => user.stat("/a/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
    throw new Error("rollback write");
  };
  await expect(user.writeFile("/a/file", "unsafe")).rejects.toThrow("rollback write");
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("before");
  await user.writeFile("/a/file", "safe");
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("safe");
});
