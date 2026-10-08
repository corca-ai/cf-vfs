import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { FsMetadataCache } from "../src/fs/metadata.js";
import { NodeSqlFileSystem } from "../src/testing/node.js";
import { readUtf8 } from "../src/vfs/streams.js";

it("resolves dotdot after a directory symlink in both the VFS and fs adapter", async () => {
  const cache = new FsMetadataCache();
  const vfs = new NodeSqlFileSystem({ onEvent: cache.onEvent });
  try {
    vfs.mkdir("/dir/sub", true);
    await vfs.writeFile("/dir/file", "target");
    await vfs.writeFile("/file", "lexical");
    vfs.symlink("/link", "dir/sub");
    const fs = createFsAdapter(vfs, { metadataCache: cache }).promises;
    await fs.stat("/file");
    expect(await readUtf8(vfs.readFile("/link/../file").stream, 100)).toBe("target");
    expect(await fs.readFile("/link/../file", "utf8")).toBe("target");
    expect((await fs.stat("/link/../file")).size).toBe(6);
    await fs.writeFile("/link/../file", "changed");
    expect(await fs.readFile("/dir/file", "utf8")).toBe("changed");
    expect(await fs.readFile("/file", "utf8")).toBe("lexical");
  } finally {
    vfs.close();
  }
});

it("requires dot and dotdot prefixes to exist and be directories", async () => {
  const vfs = new NodeSqlFileSystem();
  try {
    await vfs.writeFile("/file", "x");
    for (const path of ["/file/..", "/file/."]) {
      expect(() => vfs.stat(path)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
    }
    expect(() => vfs.stat("/missing/../file")).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(vfs.stat("/..").path).toBe("/");
  } finally {
    vfs.close();
  }
});

it("checks search permission on directories traversed before dotdot", () => {
  const vfs = new NodeSqlFileSystem();
  try {
    vfs.mkdir("/private");
    vfs.setMetadata("/private", { mode: 0o700 });
    const user = vfs.forCredentials({ uid: 1001, gid: 1001 });
    expect(() => user.stat("/private/../")).toThrow(expect.objectContaining({ code: "EACCES" }));
    vfs.setMetadata("/private", { mode: 0o111 });
    expect(user.stat("/private/../").path).toBe("/");
  } finally {
    vfs.close();
  }
});

it("resolves dotdot inside link targets and enforces one shared hop budget", async () => {
  const vfs = new NodeSqlFileSystem();
  try {
    vfs.mkdir("/dir/sub", true);
    await vfs.writeFile("/dir/file", "target");
    vfs.symlink("/link", "dir/sub");
    vfs.symlink("/nested", "link/../file");
    expect(vfs.stat("/nested").path).toBe("/dir/file");
    vfs.symlink("/cycle", "cycle/../file");
    expect(() => vfs.stat("/cycle")).toThrow(expect.objectContaining({ code: "ELOOP" }));
    expect(vfs.lstat("/nested").kind).toBe("symlink");
  } finally {
    vfs.close();
  }
});

it("guards the links crossed before dotdot during a streamed write", async () => {
  const vfs = new NodeSqlFileSystem();
  try {
    vfs.mkdir("/a/sub", true);
    vfs.mkdir("/b/sub", true);
    await vfs.writeFile("/a/file", "a");
    await vfs.writeFile("/b/file", "b");
    vfs.symlink("/link", "/a/sub");
    const token = vfs.getMutationToken("/link/../file");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        vfs.symlink("/link", "/b/sub", { replace: true });
        controller.enqueue(new TextEncoder().encode("new"));
        controller.close();
      },
    });
    await expect(
      vfs.writeFile("/link/../file", body, { ifMutationToken: token }),
    ).rejects.toMatchObject({ code: "EREVISION" });
    expect(await readUtf8(vfs.readFile("/a/file").stream, 100)).toBe("a");
    expect(await readUtf8(vfs.readFile("/b/file").stream, 100)).toBe("b");
  } finally {
    vfs.close();
  }
});

it("preserves physical dot traversal in shell scripts, glob output and redirection", async () => {
  const vfs = new NodeSqlFileSystem();
  try {
    vfs.mkdir("/real/sub", true);
    vfs.symlink("/link", "real/sub");
    await vfs.writeFile("/real/a.txt", "target");
    await vfs.writeFile("/real/script", "#!/bin/sh\nprintf physical");
    vfs.setMetadata("/real/script", { mode: 0o100755 });
    const { createBashHarness } = await import("./helpers/bash.js");
    const harness = createBashHarness({ fileSystem: vfs });
    expect((await harness.run("link/../script")).stdout).toBe("physical");
    expect((await harness.run("printf '%s' link/../*.txt")).stdout).toBe("link/../a.txt");
    expect((await harness.run("cat link/../a.txt")).stdout).toBe("target");
    await harness.run("printf changed > link/../a.txt");
    expect(await harness.readText("/real/a.txt")).toBe("changed");
  } finally {
    vfs.close();
  }
});
