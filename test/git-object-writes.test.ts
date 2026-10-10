import * as git from "isomorphic-git";
import { expect, it, vi } from "vitest";
import { VfsError } from "../src/core/errors.js";
import { createFsAdapter } from "../src/fs/index.js";
import { defineApplet } from "../src/shell/commands/applet.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { GitFileSystem } from "../src/shell/commands/git-fs.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function fixture() {
  const vfs = createTestFileSystem();
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script: string, umask = 0o022) => shell.executeText({ script, cwd: "/repo", umask });
  expect((await shell.executeText({ script: "git init /repo" })).exitCode).toBe(0);
  return { vfs, shell, run, fs: createFsAdapter(vfs) };
}

it("persists every batched blob before publishing the index", async () => {
  const { vfs, run, fs } = await fixture();
  for (let n = 0; n < 100; n++) await vfs.writeFile(`/repo/f${n}`, `body ${n}\n`);
  const batch = vi.spyOn(vfs, "writeFiles");
  const write = vfs.writeFile.bind(vfs);
  const observe = vi.spyOn(vfs, "writeFile").mockImplementation(async (path, body, options) => {
    if (path === "/repo/.git/index") {
      expect(batch).toHaveBeenCalled();
      for (const [entries] of batch.mock.calls)
        for (const entry of entries) expect(vfs.stat(entry.path).kind).toBe("file");
    }
    return write(path, body, options);
  });
  expect((await run("git add -A")).exitCode).toBe(0);
  observe.mockRestore();
  expect(await git.listFiles({ fs, dir: "/repo" })).toHaveLength(100);
  await git.walk({
    fs,
    dir: "/repo",
    trees: [git.STAGE()],
    map: async (path, [entry]) => {
      if (entry == null || (await entry.type()) !== "blob") return;
      const { blob } = await git.readBlob({ fs, dir: "/repo", oid: await entry.oid() });
      expect(new TextDecoder().decode(blob)).toBe(`body ${Number(path.slice(1))}\n`);
    },
  });
});

it("does not publish an index after a retriable-looking object batch failure", async () => {
  const { vfs, run, fs } = await fixture();
  await vfs.writeFile("/repo/seed", "seed");
  expect((await run("git add seed")).exitCode).toBe(0);
  const token = vfs.getMutationToken("/repo/.git/index");
  for (let n = 0; n < 32; n++) await vfs.writeFile(`/repo/new${n}`, `new ${n}`);
  const batch = vi
    .spyOn(vfs, "writeFiles")
    .mockRejectedValueOnce(new VfsError("ENOENT", "injected parent disappearance"));
  expect((await run("git add -A")).exitCode).toBe(1);
  expect(vfs.getMutationToken("/repo/.git/index")).toBe(token);
  expect(await git.listFiles({ fs, dir: "/repo" })).toEqual(["seed"]);
  batch.mockRestore();
  expect((await run("git add -A")).exitCode).toBe(0);
  expect(await git.listFiles({ fs, dir: "/repo" })).toHaveLength(33);
});

it.each([0o077, 0o002])("preserves object and directory creation umask %i", async (umask) => {
  const { vfs, run, fs } = await fixture();
  await vfs.writeFile("/repo/new", "new content");
  for (let n = 0; n < 31; n++) await vfs.writeFile(`/repo/f${n}`, `mode ${n}`);
  const batch = vi.spyOn(vfs, "writeFiles");
  expect((await run("git add -A", umask)).exitCode).toBe(0);
  expect(batch).toHaveBeenCalled();
  const { oid } = await git.hashBlob({ object: "new content" });
  expect(vfs.stat(`/repo/.git/objects/${oid.slice(0, 2)}`).mode & 0o777).toBe(0o777 & ~umask);
  expect(vfs.stat(`/repo/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`).mode & 0o777).toBe(
    0o666 & ~umask,
  );
  expect(await git.listFiles({ fs, dir: "/repo" })).toHaveLength(32);
});

it("falls back to individual writes when batching would consume read buffer headroom", async () => {
  const { vfs, fs } = await fixture();
  for (let n = 0; n < 100; n++) await vfs.writeFile(`/repo/f${n}`, `${n}`.padEnd(256, "x"));
  const batch = vi.spyOn(vfs, "writeFiles");
  const shell = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    limits: { maxBufferedBytes: 32 * 1024 },
  });
  expect((await shell.executeText({ script: "git add -A", cwd: "/repo" })).exitCode).toBe(0);
  expect(batch).not.toHaveBeenCalled();
  expect(await git.listFiles({ fs, dir: "/repo" })).toHaveLength(100);
});

it("preserves Git add under a small backend in-flight buffer budget", async () => {
  const vfs = createTestFileSystem({ maxInFlightBufferedBytes: 8192 });
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  expect((await shell.executeText({ script: "git init /repo" })).exitCode).toBe(0);
  for (let n = 0; n < 100; n++) {
    let seed = n + 1;
    const body = Uint8Array.from({ length: 64 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    });
    await vfs.writeFile(`/repo/f${n}`, body);
  }
  const result = await shell.executeText({ script: "git add -A", cwd: "/repo" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(await git.listFiles({ fs: createFsAdapter(vfs), dir: "/repo" })).toHaveLength(100);
});

it("keeps small staging operations on the individual-write path", async () => {
  const { vfs, run, fs } = await fixture();
  await vfs.writeFile("/repo/one", "one");
  const batch = vi.spyOn(vfs, "writeFiles");
  expect((await run("git add one")).exitCode).toBe(0);
  expect(batch).not.toHaveBeenCalled();
  expect(await git.listFiles({ fs, dir: "/repo" })).toEqual(["one"]);
});

it.each([0o022, 0o077])(
  "preserves existing loose-object permissions for umask %i",
  async (umask) => {
    const vfs = createTestFileSystem();
    const path = `/repo/.git/objects/aa/${"b".repeat(38)}`;
    vfs.mkdir("/repo/.git/objects/aa", true);
    await vfs.writeFile(path, "old", { mode: 0o640 });
    const probe = defineApplet(
      { name: "probe", usage: "", summary: "checks deferred Git writes" },
      async (context) => {
        const fs = new GitFileSystem(context);
        fs.beginObjectWrites("/repo/.git", 256, 32);
        try {
          await fs.promises.writeFile(path, "new");
          await fs.promises.writeFile("/repo/.git/index", "published");
        } finally {
          fs.endObjectWrites();
        }
        return 0;
      },
    );
    const shell = new Shell({ fileSystem: vfs, commands: [probe] });
    expect((await shell.executeText({ script: "probe", umask })).exitCode).toBe(0);
    expect(vfs.stat(path).mode & 0o777).toBe(0o640);
  },
);
