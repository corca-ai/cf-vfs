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
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand], now: () => 1700000000000 });
  const run = (script: string) => shell.executeText({ script, cwd: "/repo" });
  expect((await shell.executeText({ script: "git init /repo" })).exitCode).toBe(0);
  expect(
    (await run("git config user.name Test; git config user.email test@example.invalid")).exitCode,
  ).toBe(0);
  for (let n = 0; n < 80; n++)
    await vfs.writeFile(`/repo/d${n % 20}/f${n}`, `body ${n}\n`, { createParents: true });
  expect((await run("git add -A")).exitCode).toBe(0);
  return { vfs, run, fs: createFsAdapter(vfs) };
}

it("publishes all commit and tree objects before updating the branch reference", async () => {
  const { vfs, run, fs } = await fixture();
  const batch = vi.spyOn(vfs, "writeFiles");
  const write = vfs.writeFile.bind(vfs);
  let checked = false;
  vi.spyOn(vfs, "writeFile").mockImplementation(async (path, body, options) => {
    if (path.startsWith("/repo/.git/refs/heads/")) {
      expect(batch.mock.calls.some(([entries]) => entries.length > 1)).toBe(true);
      for (const [entries] of batch.mock.calls)
        for (const entry of entries) {
          const oid = entry.path.split("/objects/")[1]?.replace("/", "");
          expect(oid).toBeDefined();
          await git.readObject({ fs, dir: "/repo", oid: oid ?? "" });
        }
      checked = true;
    }
    return write(path, body, options);
  });
  expect((await run("git commit -m initial")).exitCode).toBe(0);
  expect(checked).toBe(true);
  expect(await git.listFiles({ fs, dir: "/repo", ref: "HEAD" })).toHaveLength(80);
});

it("leaves HEAD unchanged after an object batch failure and permits a fresh retry", async () => {
  const { vfs, run, fs } = await fixture();
  expect((await run("git commit -m initial")).exitCode).toBe(0);
  const head = await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" });
  await vfs.writeFile("/repo/d0/f0", "changed");
  expect((await run("git add -A")).exitCode).toBe(0);
  const batch = vi
    .spyOn(vfs, "writeFiles")
    .mockRejectedValueOnce(new VfsError("ENOENT", "injected object publication failure"));
  expect((await run("git commit -m next")).exitCode).toBe(1);
  expect(await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" })).toBe(head);
  batch.mockRestore();
  expect((await run("git commit -m next")).exitCode).toBe(0);
  expect(await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" })).not.toBe(head);
});

it("commits an index larger than the available batching headroom and supports a backend without batch headroom", async () => {
  const { vfs, fs } = await fixture();
  for (let n = 80; n < 1000; n++) await vfs.writeFile(`/repo/d${n % 20}/f${n}`, `body ${n}\n`);
  const run = async (batching: boolean) => {
    const view = new Proxy(vfs, {
      get(target, property) {
        if (!batching && property === "availableWriteBufferBytes") return 0;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const shell = new Shell({
      fileSystem: view,
      commands: [gitCommand],
      limits: { maxBufferedBytes: 100 * 1024 },
      now: () => 1700000000000,
    });
    const result = await shell.executeText({
      script: "git add -A; git commit --allow-empty -m bounded",
      cwd: "/repo",
    });
    expect(result.exitCode, result.stderr).toBe(0);
  };
  await run(true);
  await run(false);
  expect(await git.listFiles({ fs, dir: "/repo", ref: "HEAD" })).toHaveLength(1000);
});

it("releases commit buffers before reads, oversized writes and directory enumeration", async () => {
  const vfs = createTestFileSystem();
  vfs.mkdir("/repo/.git/objects/aa", true);
  await vfs.writeFile("/large", "r".repeat(900));
  const path = `/repo/.git/objects/aa/${"b".repeat(38)}`;
  const probe = defineApplet(
    { name: "probe", usage: "", summary: "checks commit buffer boundaries" },
    async (context) => {
      const fs = new GitFileSystem(context);
      const before = context.budget.remainingBufferedBytes?.();
      fs.beginCommitWrites("/repo/.git");
      try {
        expect(context.budget.remainingBufferedBytes?.()).toBe(before);
        await fs.promises.writeFile(path, "x".repeat(200));
        expect(await fs.promises.readFile("/large", "utf8")).toBe("r".repeat(900));
        expect(context.budget.remainingBufferedBytes?.()).toBe(before);
        await fs.promises.writeFile(path, "next");
        expect(await fs.promises.readdir("/repo/.git/objects/aa")).toEqual(["b".repeat(38)]);
        await fs.promises.writeFile(path, "last");
        await fs.promises.writeFile("/repo/.git/refs", "z".repeat(900));
        expect(context.budget.remainingBufferedBytes?.()).toBe(before);
      } finally {
        fs.endCommitWrites();
      }
      expect(context.budget.remainingBufferedBytes?.()).toBe(before);
      return 0;
    },
  );
  const shell = new Shell({
    fileSystem: vfs,
    commands: [probe],
    limits: { maxBufferedBytes: 1024 },
  });
  const result = await shell.executeText({ script: "probe" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(await new Response(vfs.readFile(path).stream).text()).toBe("last");
});

it("flushes smaller objects and releases the reservation before an oversized individual write", async () => {
  const vfs = createTestFileSystem();
  vfs.mkdir("/repo/.git/objects/aa", true);
  const small = `/repo/.git/objects/aa/${"b".repeat(38)}`;
  const large = `/repo/.git/objects/aa/${"c".repeat(38)}`;
  const probe = defineApplet(
    { name: "probe", usage: "", summary: "checks oversized commit object fallback" },
    async (context) => {
      const fs = new GitFileSystem(context);
      const before = context.budget.remainingBufferedBytes?.();
      fs.beginCommitWrites("/repo/.git");
      try {
        await fs.promises.writeFile(small, "small");
        await fs.promises.writeFile(large, new Uint8Array(256 * 1024));
        expect(context.budget.remainingBufferedBytes?.()).toBe(before);
      } finally {
        fs.endCommitWrites();
      }
      return 0;
    },
  );
  const shell = new Shell({
    fileSystem: vfs,
    commands: [probe],
    limits: { maxBufferedBytes: 300 * 1024 },
  });
  const result = await shell.executeText({ script: "probe" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(await new Response(vfs.readFile(small).stream).text()).toBe("small");
  expect(vfs.stat(large).sizeBytes).toBe(256 * 1024);
});

it.each([false, undefined])(
  "uses individual object writes when bulk eligibility is %s",
  async (eligible) => {
    const { vfs, fs } = await fixture();
    const view = new Proxy(vfs, {
      get(target, property) {
        if (property === "canUseBulkOperation")
          return eligible === undefined ? undefined : () => eligible;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const batch = vi
      .spyOn(vfs, "writeFiles")
      .mockRejectedValue(new VfsError("ENOTSUP", "this view requires individual writes"));
    const shell = new Shell({ fileSystem: view, commands: [gitCommand] });
    const result = await shell.executeText({ script: "git commit -m supported", cwd: "/repo" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(batch).not.toHaveBeenCalled();
    expect(await git.listFiles({ fs, dir: "/repo", ref: "HEAD" })).toHaveLength(80);
  },
);
