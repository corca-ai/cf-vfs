import { expect, it } from "vitest";
import { NodeSqlFileSystem } from "../src/testing/node.js";
import { meteredFileSystem } from "./helpers/performance.js";

it("checks ancestors and entry together without skipping search permission", async () => {
  const { fileSystem: vfs, meter } = meteredFileSystem();
  vfs.mkdir("/a/b/c", true);
  await vfs.writeFile("/a/b/c/file", "x");
  const user = vfs.forCredentials({ uid: 1001, gid: 1001 });
  meter.reset();
  expect(user.stat("/a/b/c/file").sizeBytes).toBe(1);
  expect(meter.statements).toBe(1);
  vfs.setMetadata("/a/b", { mode: 0o700 });
  expect(() => user.stat("/a/b/c/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
  expect(() => user.stat("/a/b/c/missing")).toThrow(expect.objectContaining({ code: "EACCES" }));
  vfs.setMetadata("/a/b", { mode: 0o755 });
  expect(() => user.stat("/a/b/c/missing")).toThrow(expect.objectContaining({ code: "ENOENT" }));
  expect(user.stat("/").kind).toBe("directory");
});

it("preserves symlink and trailing-slash checks after the stat optimization", async () => {
  const vfs = new NodeSqlFileSystem();
  try {
    vfs.mkdir("/private");
    await vfs.writeFile("/private/file", "x");
    vfs.symlink("/link", "/private/file");
    vfs.setMetadata("/private", { mode: 0o700 });
    const user = vfs.forCredentials({ uid: 1001, gid: 1001 });
    expect(user.lstat("/link").kind).toBe("symlink");
    expect(() => user.stat("/link")).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(() => vfs.stat("/private/file/")).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  } finally {
    vfs.close();
  }
});

it("replaces a destination without fetching its metadata again", async () => {
  const { fileSystem: vfs, meter } = meteredFileSystem();
  await vfs.writeFile("/a", "source");
  await vfs.writeFile("/b", "destination");
  const ino = vfs.stat("/a").ino;
  meter.reset();
  await vfs.move("/a", "/b", { replace: true });
  expect(meter.statements).toBe(14);
  expect(vfs.stat("/b").ino).toBe(ino);
  expect(() => vfs.stat("/a")).toThrow(expect.objectContaining({ code: "ENOENT" }));
});
