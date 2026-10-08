import { expect, it } from "vitest";
import { NodeSqlFileSystem } from "../src/testing/node.js";

it("keeps mtime on chmod, chown and rename while advancing independent ctime", async () => {
  let clock = 10;
  const vfs = new NodeSqlFileSystem({ now: () => clock });
  try {
    await vfs.writeFile("/a", "x");
    clock = 20;
    const mode = vfs.setMetadata("/a", { mode: 0o100600 });
    expect(mode.modifiedAtMs).toBe(10);
    expect(mode.changedAtMs).toBe(20);
    clock = 30;
    expect(vfs.setOwnership("/a", { uid: 1 }).modifiedAtMs).toBe(10);
    expect(vfs.stat("/a").changedAtMs).toBe(30);
    clock = 40;
    await vfs.move("/a", "/b");
    expect(vfs.stat("/b").modifiedAtMs).toBe(10);
    expect(vfs.stat("/b").changedAtMs).toBe(40);
  } finally {
    vfs.close();
  }
});

it("updates both namespace parents but does not change them on overwrite or rollback", async () => {
  let clock = 10;
  const vfs = new NodeSqlFileSystem({ now: () => clock });
  try {
    vfs.mkdir("/a");
    vfs.mkdir("/b");
    clock = 20;
    await vfs.writeFile("/a/file", "x");
    expect(vfs.stat("/a").modifiedAtMs).toBe(20);
    clock = 30;
    await vfs.writeFile("/a/file", "y");
    expect(vfs.stat("/a").modifiedAtMs).toBe(20);
    clock = 40;
    await vfs.move("/a/file", "/b/file");
    expect(vfs.stat("/a").modifiedAtMs).toBe(40);
    expect(vfs.stat("/b").modifiedAtMs).toBe(40);
    clock = 50;
    await expect(vfs.move("/missing", "/b/no")).rejects.toMatchObject({ code: "ENOENT" });
    expect(vfs.stat("/b").modifiedAtMs).toBe(40);
    await vfs.remove("/b/file");
    expect(vfs.stat("/b").modifiedAtMs).toBe(50);
  } finally {
    vfs.close();
  }
});
