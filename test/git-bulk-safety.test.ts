import * as git from "isomorphic-git";
import { expect, it, vi } from "vitest";
import { applyTextEdits, CollaborativeFileSystem, DocumentRegistry } from "../src/collab/index.js";
import { VfsError } from "../src/core/errors.js";
import { createFsAdapter } from "../src/fs/index.js";
import { defineApplet } from "../src/shell/commands/applet.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { GitFileSystem } from "../src/shell/commands/git-fs.js";
import { copyFreshGitObjects, GitObjectTree } from "../src/shell/commands/git-object-copy.js";
import { Shell } from "../src/shell/shell.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function fixture(options: Parameters<typeof createTestFileSystem>[0] = {}) {
  const raw = createTestFileSystem(options);
  const registry = new DocumentRegistry();
  const view = new CollaborativeFileSystem(raw, registry);
  const shell = new Shell({ fileSystem: view, commands: [gitCommand] });
  const ok = async (script: string) => {
    const result = await shell.executeText({ script, cwd: "/repo" });
    expect(result.exitCode, result.stderr).toBe(0);
    return result;
  };
  expect((await shell.executeText({ script: "git init /repo" })).exitCode).toBe(0);
  await ok("git config user.name Test; git config user.email test@example.invalid");
  for (let n = 0; n < 64; n++) await raw.writeFile(`/repo/f${n}`, `base ${n}\n`);
  await ok("git add -A; git commit -m base; git branch base");
  const open = (path: string, initial: string) => {
    let text = initial;
    const document = {
      text: () => text,
      applyExternal: (edits: Parameters<typeof applyTextEdits>[1]) => {
        text = applyTextEdits(text, edits);
      },
    };
    registry.open(path, document, raw.stat(path).mutationToken);
    return {
      document,
      edit(value: string) {
        text = value;
        registry.markDirty(path);
      },
    };
  };
  const body = (path: string) => new Response(raw.readFile(path).stream).text();
  return { raw, registry, view, shell, ok, open, body };
}

it("copies same-size unpublished object-store text instead of stored bytes, including aliases", async () => {
  const { raw, ok, open, body } = await fixture();
  const path = "/repo/.git/objects/info/note";
  await raw.writeFile(path, "stored!\n");
  const pending = open(path, "stored!\n");
  pending.edit("pending\n");
  raw.symlink("/alias", "/repo");
  const copy = vi.spyOn(raw, "copy");
  await ok("git clone /alias /copy");
  expect(copy).not.toHaveBeenCalled();
  expect(await body("/copy/.git/objects/info/note")).toBe("pending\n");
  expect(pending.document.text()).toBe("pending\n");
  expect(await body(path)).toBe("stored!\n");
});

it("still bulk copies committed objects when only a source worktree document is open", async () => {
  const { raw, ok, open, body } = await fixture();
  const pending = open("/repo/f0", "base 0\n");
  pending.edit("local edit\n");
  const copy = vi.spyOn(raw, "copy");
  await ok("git clone /repo /copy");
  expect(copy).toHaveBeenCalledOnce();
  expect(await body("/copy/f0")).toBe("base 0\n");
  expect(pending.document.text()).toBe("local edit\n");
});

it("checks out open documents individually while batching ordinary siblings", async () => {
  const { raw, ok, open, body } = await fixture();
  for (let n = 0; n < 64; n++) await raw.writeFile(`/repo/f${n}`, `next ${n}\n`);
  await ok("git add -A; git commit -m next");
  const opened = open("/repo/f0", "next 0\n");
  opened.edit("unsaved edit\n");
  const batch = vi.spyOn(raw, "writeFiles");
  await ok("git checkout --force base");
  expect(opened.document.text()).toBe("base 0\n");
  expect(batch.mock.calls.some(([entries]) => entries.length > 1)).toBe(true);
  expect(
    batch.mock.calls.every(([entries]) => entries.every((entry) => entry.path !== "/repo/f0")),
  ).toBe(true);
  for (let n = 1; n < 64; n++) expect(await body(`/repo/f${n}`)).toBe(`base ${n}\n`);
  expect((await ok("git status --porcelain")).stdout).toBe("");
});

it("retains single-file transport when an implementation does not publish bulk eligibility", async () => {
  const { raw, body } = await fixture();
  const legacy = new Proxy(raw, {
    get(target, property) {
      if (property === "canUseBulkOperation") return undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const copy = vi.spyOn(raw, "copy"),
    batch = vi.spyOn(raw, "writeFiles");
  const shell = new Shell({ fileSystem: legacy, commands: [gitCommand] });
  const result = await shell.executeText({ script: "git clone /repo /copy" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(copy).not.toHaveBeenCalled();
  expect(batch).not.toHaveBeenCalled();
  expect(await body("/copy/f0")).toBe("base 0\n");
});

it.each([1, 2])("rechecks queued targets with a mutation budget of %i", async (mutations) => {
  const { raw, view, open, body } = await fixture();
  let edited: ReturnType<typeof open> | undefined;
  const probe = defineApplet(
    { name: "probe", usage: "", summary: "queues test writes" },
    async (context) => {
      const fs = new GitFileSystem(context);
      fs.beginCheckoutWrites("/repo", "/repo/.git");
      const a = fs.promises.writeFile("/repo/f0", "new a\n");
      const b = fs.promises.writeFile("/repo/f1", "new b\n");
      edited = open("/repo/f0", "base 0\n");
      const outcomes = await Promise.allSettled([a, b]);
      expect(outcomes.map((item) => item.status)).toEqual([
        mutations === 2 ? "fulfilled" : "rejected",
        "fulfilled",
      ]);
      fs.endCheckoutWrites();
      return 0;
    },
  );
  const batch = vi.spyOn(raw, "writeFiles");
  const shell = new Shell({
    fileSystem: view,
    commands: [probe],
    limits: { maxTotalIoBytes: 12, maxBufferedBytes: 12 },
    policy: { maxMutations: mutations },
  });
  const result = await shell.executeText({ script: "probe" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(edited?.document.text()).toBe(mutations === 2 ? "new a\n" : "base 0\n");
  expect(await body("/repo/f1")).toBe("new b\n");
  expect(batch.mock.calls.flatMap(([entries]) => entries.map((entry) => entry.path))).toEqual([
    "/repo/f1",
  ]);
});

it("cancels queued batches without modifying files or retaining their buffer budget", async () => {
  const { raw, view, body } = await fixture();
  const controller = new AbortController();
  const probe = defineApplet(
    { name: "probe", usage: "", summary: "cancels queued writes" },
    async (context) => {
      const fs = new GitFileSystem(context);
      const before = context.budget.remainingBufferedBytes?.();
      fs.beginCheckoutWrites("/repo", "/repo/.git");
      const pending = [
        fs.promises.writeFile("/repo/f0", "changed\n"),
        fs.promises.writeFile("/repo/f1", "changed\n"),
      ];
      controller.abort();
      const outcomes = await Promise.allSettled(pending);
      expect(outcomes.every((item) => item.status === "rejected")).toBe(true);
      expect(context.budget.remainingBufferedBytes?.()).toBe(before);
      fs.endCheckoutWrites();
      return 1;
    },
  );
  const batch = vi.spyOn(raw, "writeFiles");
  const shell = new Shell({ fileSystem: view, commands: [probe] });
  expect(
    (await shell.executeText({ script: "probe", signal: controller.signal })).exitCode,
  ).not.toBe(0);
  expect(batch).not.toHaveBeenCalled();
  expect(await body("/repo/f0")).toBe("base 0\n");
  expect(await body("/repo/f1")).toBe("base 1\n");
});

it("recognizes open-document aliases and refuses hints outside shell roots", async () => {
  const { raw, view, open } = await fixture();
  open("/repo/f0", "base 0\n");
  raw.symlink("/alias", "/repo");
  expect(view.canUseBulkOperation("write-target", "/alias/f0")).toBe(false);
  expect(view.canUseBulkOperation("copy-source", "/alias")).toBe(false);
  expect(
    view.forCredentials({ uid: 0, gid: 0 }).canUseBulkOperation?.("write-target", "/alias/f0"),
  ).toBe(false);
  const probe = defineApplet(
    { name: "probe", usage: "", summary: "checks scoped hints" },
    (context) => {
      expect(() => context.fileSystem.canUseBulkOperation?.("copy-source", "/repo")).toThrow();
      expect(() => context.fileSystem.canUseBulkOperation?.("write-target", "/repo/f1")).toThrow();
      expect(context.fileSystem.canUseBulkOperation?.("copy-source", "/dev/null")).toBe(false);
      return 0;
    },
  );
  raw.mkdir("/allowed");
  const shell = new Shell({
    fileSystem: view,
    commands: [probe],
    policy: { readRoots: ["/allowed"], writeRoots: ["/allowed"] },
  });
  expect((await shell.executeText({ script: "probe", cwd: "/allowed" })).exitCode).toBe(0);
});

it("recovers a real batched checkout failure without changing committed history", async () => {
  const { raw, ok, body } = await fixture();
  for (let n = 0; n < 64; n++) await raw.writeFile(`/repo/f${n}`, `next ${n}\n`);
  await ok("git add -A; git commit -m next");
  const fs = createFsAdapter(raw);
  const head = await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" });
  let batches = 0;
  const faulty = new Proxy(raw, {
    get(target, property) {
      if (property === "forCredentials") return undefined;
      if (property === "writeFiles")
        return async (...args: Parameters<VirtualFileSystem["writeFiles"]>) => {
          if (args[0].some((entry) => entry.path.startsWith("/repo/f")) && ++batches === 2)
            throw new VfsError("ENOSPC", "injected batch failure");
          return target.writeFiles(...args);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const failed = await new Shell({ fileSystem: faulty, commands: [gitCommand] }).executeText({
    script: "git checkout base",
    cwd: "/repo",
  });
  expect(failed.exitCode).not.toBe(0);
  expect(batches).toBeGreaterThanOrEqual(2);
  expect(await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" })).toBe(head);
  expect(await git.listFiles({ fs, dir: "/repo" })).toHaveLength(64);
  let changed = 0;
  for (let n = 0; n < 64; n++) {
    const text = await body(`/repo/f${n}`);
    expect([`base ${n}\n`, `next ${n}\n`]).toContain(text);
    if (text === `base ${n}\n`) changed++;
    const { blob } = await git.readBlob({ fs, dir: "/repo", oid: head, filepath: `f${n}` });
    expect(new TextDecoder().decode(blob)).toBe(`next ${n}\n`);
  }
  expect(changed).toBeGreaterThan(0);
  expect(changed).toBeLessThan(64);
  await ok("git checkout --force base");
  for (let n = 0; n < 64; n++) expect(await body(`/repo/f${n}`)).toBe(`base ${n}\n`);
  expect((await ok("git status --porcelain")).stdout).toBe("");
});

it("reuses preflight listings when unusual object permissions select the original walker", async () => {
  const { raw, ok } = await fixture();
  const directory = raw
    .list("/repo/.git/objects")
    .find(
      (entry) =>
        entry.kind === "directory" && raw.list(entry.path).some((child) => child.kind === "file"),
    );
  expect(directory).toBeDefined();
  const object = raw.list(directory?.path ?? "").find((entry) => entry.kind === "file");
  expect(object).toBeDefined();
  raw.setMetadata(object?.path ?? "", { mode: 0o100600 });
  const list = vi.spyOn(raw, "list"),
    copy = vi.spyOn(raw, "copy");
  await ok("git clone /repo /copy");
  expect(copy).not.toHaveBeenCalled();
  const paths = list.mock.calls
    .map(([path]) => path)
    .filter((path) => path.startsWith("/repo/.git/objects"));
  expect(new Set(paths).size).toBe(paths.length);
  expect(raw.stat((object?.path ?? "").replace("/repo/", "/copy/")).mode).toBe(0o100644);
});

it("retains umask when ordinary source permissions cannot be copied verbatim", async () => {
  const { raw, shell } = await fixture();
  const copy = vi.spyOn(raw, "copy");
  const result = await shell.executeText({ script: "git clone /repo /private-copy", umask: 0o077 });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(copy).not.toHaveBeenCalled();
  expect(raw.stat("/private-copy/f0").mode).toBe(0o100600);
  expect(raw.stat("/private-copy/.git/objects").mode).toBe(0o40700);
});

it("retries a quota-refused bulk clone without changing source history or index", async () => {
  let maximum = 32 * 1024 * 1024;
  const { raw, ok, shell, body } = await fixture({ maxInlineLogicalBytes: () => maximum });
  const fs = createFsAdapter(raw);
  const head = await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" });
  const index = await body("/repo/.git/index");
  maximum = raw.subtreeSummary("/").logicalFileBytes + 512;
  const copy = vi.spyOn(raw, "copy");
  const failed = await shell.executeText({ script: "git clone /repo /copy" });
  expect(failed.exitCode).not.toBe(0);
  expect(copy).toHaveBeenCalled();
  expect(await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" })).toBe(head);
  expect(await body("/repo/.git/index")).toBe(index);
  maximum = 32 * 1024 * 1024;
  await raw.remove("/copy", { recursive: true });
  await ok("git clone /repo /copy");
  expect(await body("/copy/f0")).toBe("base 0\n");
});

it.each([
  { io: 64, mutations: 3, buffer: 16, exit: 0 },
  { io: 63, mutations: 3, buffer: 16, exit: 1 },
  { io: 64, mutations: 2, buffer: 16, exit: 1 },
  { io: 64, mutations: 3, buffer: 15, exit: 1 },
])("accounts bulk copy I/O, mutations and conservative buffer limits: %j", async (limits) => {
  const raw = createTestFileSystem();
  raw.mkdir("/source");
  raw.mkdir("/target");
  await raw.writeFile("/source/a", "0123456789abcdef");
  await raw.writeFile("/source/b", "0123456789abcdef");
  const probe = defineApplet(
    { name: "probe", usage: "", summary: "copies test objects" },
    async (context) => {
      const fs = new GitFileSystem(context);
      expect(await copyFreshGitObjects(fs, "/source", "/target", new GitObjectTree(fs))).toBe(true);
      return 0;
    },
  );
  const shell = new Shell({
    fileSystem: raw,
    commands: [probe],
    policy: { maxMutations: limits.mutations },
    limits: { maxTotalIoBytes: limits.io, maxBufferedBytes: limits.buffer },
  });
  const result = await shell.executeText({ script: "probe" });
  expect(result.exitCode, result.stderr).toBe(limits.exit);
  expect(raw.list("/target")).toHaveLength(limits.exit === 0 ? 2 : 0);
});

it("recovers after an actual storage quota refuses batched checkout growth", async () => {
  let maximum = 32 * 1024 * 1024;
  const { raw, shell, ok, body } = await fixture({ maxInlineLogicalBytes: () => maximum });
  for (let n = 0; n < 64; n++) await raw.writeFile(`/repo/f${n}`, "x");
  await ok("git add -A; git commit -m next");
  const fs = createFsAdapter(raw);
  const head = await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" });
  maximum = raw.subtreeSummary("/").logicalFileBytes + 32;
  const batches = vi.spyOn(raw, "writeFiles");
  const failed = await shell.executeText({ script: "git checkout base", cwd: "/repo" });
  expect(failed.exitCode).not.toBe(0);
  expect(batches).toHaveBeenCalled();
  expect(await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" })).toBe(head);
  for (let n = 0; n < 64; n++) expect(await body(`/repo/f${n}`)).toBe("x");
  maximum = 32 * 1024 * 1024;
  await ok("git checkout base");
  for (let n = 0; n < 64; n++) expect(await body(`/repo/f${n}`)).toBe(`base ${n}\n`);
  expect((await ok("git status --porcelain")).stdout).toBe("");
});
