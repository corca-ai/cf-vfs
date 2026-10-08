import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { NodeSqlFileSystem } from "../src/testing/node.js";

it("shares identity, metadata and content across names while preserving directory membership", async () => {
  const vfs = new NodeSqlFileSystem();
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "old");
    await f.link("/a", "/b");
    expect((await f.stat("/a")).ino).toBe((await f.stat("/b")).ino);
    expect((await f.stat("/b")).nlink).toBe(2);
    await f.writeFile("/b", "changed");
    expect(await f.readFile("/a", "utf8")).toBe("changed");
    await f.chmod("/a", 0o600);
    expect((await f.stat("/b")).mode & 0o777).toBe(0o600);
    await f.writeFile("/a", "!", { flag: "a" });
    expect(await f.readFile("/b", "utf8")).toBe("changed!");
    await f.unlink("/a");
    expect((await f.stat("/b")).nlink).toBe(1);
    expect(await f.readFile("/b", "utf8")).toBe("changed!");
    expect(await f.readdir("/")).toEqual(["b"]);
  } finally {
    vfs.close();
  }
});

it("keeps all descriptors on the same inode through the last hard-link unlink", async () => {
  const vfs = new NodeSqlFileSystem({ chunkBytes: 4 });
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "12345678");
    const a = await f.open("/a", "r+");
    await f.link("/a", "/b");
    const b = await f.open("/b", "r+");
    await f.unlink("/a");
    await b.write("XY", 0);
    expect(await f.readFile("/b", "utf8")).toBe("XY345678");
    await a.write("ZZ", 4);
    expect(await f.readFile("/b", "utf8")).toBe("XY34ZZ78");
    await f.unlink("/b");
    await a.write("xx", 0);
    expect(await b.readFile("utf8")).toBe("xx34ZZ78");
    expect((await a.stat()).nlink).toBe(0);
    await a.close();
    await b.close();
  } finally {
    vfs.close();
  }
});

it("links symlink inodes and refuses directories and occupied names", async () => {
  const vfs = new NodeSqlFileSystem();
  const f = createFsAdapter(vfs).promises;
  try {
    await f.symlink("missing", "/link");
    await f.link("/link", "/other");
    expect(await f.readlink("/other")).toBe("missing");
    expect((await f.lstat("/link")).ino).toBe((await f.lstat("/other")).ino);
    await expect(f.link("/link", "/other")).rejects.toMatchObject({ code: "EEXIST" });
    await f.mkdir("/dir");
    await expect(f.link("/dir", "/new")).rejects.toMatchObject({ code: "EPERM" });
  } finally {
    vfs.close();
  }
});

it("accounts replicated inline chunks and rolls back aliases when quota is exhausted", async () => {
  const vfs = new NodeSqlFileSystem({ maxInlineLogicalBytes: 8 });
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "1234");
    await f.link("/a", "/b");
    await expect(f.writeFile("/a", "12345")).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(f.link("/a", "/c")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await f.readdir("/")).toEqual(["a", "b"]);
    await f.unlink("/b");
    await f.writeFile("/a", "12345678");
  } finally {
    vfs.close();
  }
});

it("preserves aliases when copying over a linked file and refuses self-inode copies", async () => {
  const vfs = new NodeSqlFileSystem({ chunkBytes: 4 });
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "1234567890");
    await f.link("/a", "/b");
    await expect(vfs.copy("/a", "/b", { replace: true })).rejects.toMatchObject({ code: "EINVAL" });
    await f.writeFile("/source", "xy");
    await vfs.copy("/source", "/b", { replace: true });
    expect(await f.readFile("/a", "utf8")).toBe("xy");
    expect(await f.readFile("/b", "utf8")).toBe("xy");
    expect((await f.stat("/a")).ino).toBe((await f.stat("/b")).ino);
    await f.rename("/a", "/b");
    expect(await f.readdir("/")).toEqual(["a", "b", "source"]);
  } finally {
    vfs.close();
  }
});

it("reports directory link counts after namespace mutations", async () => {
  const vfs = new NodeSqlFileSystem();
  const f = createFsAdapter(vfs).promises;
  try {
    expect((await f.stat("/")).nlink).toBe(2);
    await f.mkdir("/a");
    await f.mkdir("/a/b");
    expect((await f.stat("/")).nlink).toBe(3);
    expect((await f.stat("/a")).nlink).toBe(3);
    await f.rename("/a/b", "/b");
    expect((await f.stat("/")).nlink).toBe(4);
    expect((await f.stat("/a")).nlink).toBe(2);
    await f.rmdir("/b");
    expect((await f.stat("/")).nlink).toBe(3);
  } finally {
    vfs.close();
  }
});

it("publishes alias metadata changes and invalidates digests after descriptor writes", async () => {
  const vfs = new NodeSqlFileSystem({ recordChanges: true });
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "old");
    await f.link("/a", "/b");
    for (let i = 0; i < 3; i++) await f.writeFile("/c", "xxx");
    await f.rename("/a", "/c");
    await vfs.writeFile("/c", "old", { skipIfUnchanged: true });
    const h = await f.open("/c", "r+");
    await h.write("NEW", 0);
    await vfs.writeFile("/b", "old", { skipIfUnchanged: true });
    expect(await f.readFile("/b", "utf8")).toBe("old");
    const cursor = vfs.changesSince(0).cursor;
    await f.unlink("/c");
    expect(vfs.changesSince(cursor).changes.map((c) => c.path)).toContain("/b");
    expect(await h.readFile("utf8")).toBe("old");
    await h.close();
  } finally {
    vfs.close();
  }
});

it("resolves public inode identity without exposing internal alias row IDs", async () => {
  const vfs = new NodeSqlFileSystem();
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "x");
    const ino = (await f.stat("/a")).ino;
    await f.link("/a", "/b");
    expect(() => vfs.statById(ino + 1)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    await f.unlink("/a");
    expect(vfs.statById(ino)).toMatchObject({ ino, path: "/b" });
  } finally {
    vfs.close();
  }
});
