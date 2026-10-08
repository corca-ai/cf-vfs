import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { FsMetadataCache } from "../src/fs/metadata.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("round trips bytes, UTF-8 and dirents without a Node dependency", async () => {
  const vfs = createTestFileSystem();
  const fs = createFsAdapter(vfs).promises;
  await fs.mkdir("/dir");
  await fs.writeFile("/dir/bytes", Uint8Array.of(255, 0, 1));
  await fs.writeFile("/dir/text", "안녕");
  expect(await fs.readFile("/dir/bytes")).toEqual(Uint8Array.of(255, 0, 1));
  expect(await fs.readFile("/dir/text", "utf8")).toBe("안녕");
  const entries = await fs.readdir("/dir", { withFileTypes: true });
  expect(entries.map((entry) => [entry.name, entry.isFile()])).toEqual([
    ["bytes", true],
    ["text", true],
  ]);
  const stat = await fs.stat("/dir/text");
  expect(stat.size).toBe(6);
  expect(stat.ino).toBe(vfs.stat("/dir/text").ino);
  expect(stat.mtime.getTime()).toBe(vfs.stat("/dir/text").modifiedAtMs);
  expect(stat.mtime).toBe(stat.mtime);
  stat.mtime.setTime(0);
  expect((await fs.stat("/dir/text")).mtime.getTime()).toBe(vfs.stat("/dir/text").modifiedAtMs);
});

it("preserves exclusive creation, append and creation-only mode semantics", async () => {
  const fs = createFsAdapter(createTestFileSystem()).promises;
  await fs.writeFile("/file", "a", { flag: "ax", mode: 0o600 });
  expect((await fs.stat("/file")).mode).toBe(0o100600);
  await expect(fs.writeFile("/file", "b", { flag: "wx" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  await fs.writeFile("/file", "b", { flag: "a" });
  expect(await fs.readFile("/file", "utf8")).toBe("ab");
  await fs.writeFile("/file", "c", { mode: 0o777 });
  expect((await fs.stat("/file")).mode).toBe(0o100600);
  await fs.chmod("/file", 0o755);
  expect((await fs.stat("/file")).mode).toBe(0o100755);
  await fs.writeFile("/new", "new", { flag: "a" });
  expect(await fs.readFile("/new", "utf8")).toBe("new");
});

it("distinguishes symlinks and refuses exclusive creation through dangling links", async () => {
  const fs = createFsAdapter(createTestFileSystem()).promises;
  await fs.symlink("/target", "/link");
  expect((await fs.lstat("/link")).isSymbolicLink()).toBe(true);
  await expect(fs.writeFile("/link", "x", { flag: "wx" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  await fs.writeFile("/link", "target");
  expect((await fs.stat("/link")).isFile()).toBe(true);
  expect(await fs.readlink("/link")).toBe("/target");
  await fs.unlink("/link");
  expect(await fs.readFile("/target", "utf8")).toBe("target");
});

it("preserves directory errors, cwd and atomic rename replacement", async () => {
  const vfs = createTestFileSystem();
  vfs.mkdir("/base");
  const fs = createFsAdapter(vfs, { cwd: "/base" }).promises;
  await fs.mkdir("dir");
  await expect(fs.mkdir("dir")).rejects.toMatchObject({ code: "EEXIST" });
  await expect(fs.unlink("dir")).rejects.toMatchObject({ code: "EISDIR" });
  await expect(fs.rm("dir")).rejects.toMatchObject({ code: "EISDIR" });
  await fs.writeFile("a", "a");
  await fs.writeFile("b", "b");
  await expect(fs.rmdir("a")).rejects.toMatchObject({ code: "ENOTDIR" });
  await fs.rename("a", "b");
  expect(await fs.readFile("b", "utf8")).toBe("a");
  await expect(fs.stat("b/")).rejects.toMatchObject({ code: "ENOTDIR" });
  await fs.rm("absent", { force: true });
  await fs.rm("dir", { recursive: true });
});

it("releases snapshot budget after failed materialization", async () => {
  const vfs = createTestFileSystem({ maxInFlightBufferedBytes: 8 });
  await vfs.writeFile("/file", "12345678");
  const fs = createFsAdapter(vfs, { maxReadFileBytes: 4 }).promises;
  await expect(fs.readFile("/file")).rejects.toMatchObject({ code: "EFBIG" });
  await vfs.writeFile("/file", "1234");
  expect(await fs.readFile("/file", "utf8")).toBe("1234");
});

it("sees direct VFS edits through the optional cache", async () => {
  const cache = new FsMetadataCache();
  const vfs = createTestFileSystem({ onEvent: cache.onEvent });
  const fs = createFsAdapter(vfs, { metadataCache: cache }).promises;
  await fs.writeFile("/a", "old");
  await fs.readdir("/");
  await vfs.writeFile("/a", "longer");
  expect((await fs.lstat("/a")).size).toBe(6);
});

it("releases its materialization reservation when a host stream is already locked", async () => {
  const vfs = createTestFileSystem();
  await vfs.writeFile("/file", "12345678");
  const opened = vfs.readFile("/file");
  const reader = opened.stream.getReader();
  let first = true;
  const content = {
    open: async () => {
      if (first) {
        first = false;
        return opened;
      }
      return vfs.readFile("/file");
    },
    write: vfs.writeFile.bind(vfs),
  };
  const fs = createFsAdapter(vfs, { content, maxInFlightReadBytes: 8 }).promises;
  await expect(fs.readFile("/file")).rejects.toBeInstanceOf(TypeError);
  await reader.cancel();
  expect(await fs.readFile("/file", "utf8")).toBe("12345678");
});
