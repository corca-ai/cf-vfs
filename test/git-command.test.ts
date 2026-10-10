import * as git from "isomorphic-git";
import { expect, it, vi } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellPolicy } from "../src/shell/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

function fixture(policy?: ShellPolicy) {
  const vfs = createTestFileSystem();
  const shell = new Shell({
    fileSystem: vfs,
    commands: [...defaultShellCommands, gitCommand],
    ...(policy === undefined ? {} : { policy }),
  });
  const fs = createFsAdapter(vfs);
  const run = async (script: string, cwd = "/") => shell.executeText({ script, cwd });
  const ok = async (script: string, cwd = "/") => {
    const result = await run(script, cwd);
    expect(result.exitCode, `${script}\n${result.stderr}`).toBe(0);
    return result;
  };
  const seed = async () => {
    await ok("git init -b main /source");
    await ok("git config user.name Tester; git config user.email tester@example.com", "/source");
    await vfs.writeFile("/source/a.txt", "first\n");
    await ok("git add a.txt; git commit -m initial", "/source");
  };
  return { vfs, shell, fs, run, ok, seed };
}

it("reads new staging bodies once while preserving autocrlf, empty files and symlink blobs", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  await ok("git config core.autocrlf true", "/source");
  await vfs.writeFile("/source/new.txt", "new\r\n");
  await vfs.writeFile("/source/empty", "");
  vfs.symlink("/source/link", "new.txt");
  const read = vi.spyOn(vfs, "readFile");
  await ok("git add new.txt empty link", "/source");
  expect(read.mock.calls.filter(([path]) => path === "/source/new.txt")).toHaveLength(1);
  expect(read.mock.calls.filter(([path]) => path === "/source/empty")).toHaveLength(1);
  read.mockRestore();
  await ok("git commit -m added", "/source");
  const oid = await git.resolveRef({ fs, dir: "/source", ref: "HEAD" });
  const { tree } = await git.readTree({ fs, dir: "/source", oid });
  for (const [name, expected] of [
    ["new.txt", "new\n"],
    ["empty", ""],
    ["link", "new.txt"],
  ]) {
    const entry = tree.find((item) => item.path === name);
    expect(entry).toBeDefined();
    const { blob } = await git.readBlob({ fs, dir: "/source", oid: entry?.oid ?? "" });
    expect(new TextDecoder().decode(blob)).toBe(expected);
  }
  expect(tree.find((entry) => entry.path === "link")?.mode).toBe("120000");
});

it("coalesces concurrent config reads without retaining rules between add commands", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  for (let n = 0; n < 200; n++) await vfs.writeFile(`/source/f${n}`, "same\r\n");
  await ok("git add -A; git commit -m expanded", "/source");
  const index = vfs.getMutationToken("/source/.git/index");
  const read = vi.spyOn(vfs, "readFile");
  await ok("git add -A", "/source");
  expect(
    read.mock.calls.filter(([path]) => path === "/source/.git/config").length,
  ).toBeLessThanOrEqual(4);
  expect(vfs.getMutationToken("/source/.git/index")).toBe(index);
  read.mockRestore();
  await ok("git config core.autocrlf true; git add -A; git commit -m normalize", "/source");
  const oid = await git.resolveRef({ fs, dir: "/source", ref: "HEAD" });
  const { tree } = await git.readTree({ fs, dir: "/source", oid });
  const { blob } = await git.readBlob({
    fs,
    dir: "/source",
    oid: tree.find((entry) => entry.path === "f0")?.oid ?? "",
  });
  expect(new TextDecoder().decode(blob)).toBe("same\n");
});

it("stages selected paths without reading unrelated file bodies or rewriting an unchanged index", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  vfs.mkdir("/source/nested");
  await vfs.writeFile("/source/nested/selected", "before\n");
  await vfs.writeFile("/source/unrelated", "unrelated\n");
  await ok("git add -A; git commit -m expanded", "/source");
  const index = vfs.getMutationToken("/source/.git/index");
  await ok("git add -A", "/source");
  expect(vfs.getMutationToken("/source/.git/index")).toEqual(index);
  await vfs.writeFile("/source/nested/selected", "after!\n");
  await vfs.writeFile("/source/unrelated", "also changed\n");
  const read = vi.spyOn(vfs, "readFile");
  await ok("git add nested/selected", "/source");
  expect(read.mock.calls.some(([path]) => path === "/source/unrelated")).toBe(false);
  read.mockRestore();
  const matrix = await git.statusMatrix({ fs, dir: "/source" });
  expect(matrix.find(([path]) => path === "nested/selected")).toEqual(["nested/selected", 1, 2, 2]);
  expect(matrix.find(([path]) => path === "unrelated")?.[3]).toBe(1);
  vfs.remove("/source/nested/selected");
  await ok("git add nested", "/source");
  expect(
    (await git.statusMatrix({ fs, dir: "/source" })).find(
      ([path]) => path === "nested/selected",
    )?.[3],
  ).toBe(0);
});

it("preserves ignore rules for new and HEAD-only paths while staging tracked ignored changes", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  await vfs.writeFile("/source/.gitignore", "a.txt\nignored\n");
  await vfs.writeFile("/source/ignored", "untracked\n");
  await vfs.writeFile("/source/a.txt", "tracked change\n");
  await ok("git add -A", "/source");
  expect(await git.listFiles({ fs, dir: "/source" })).toEqual([".gitignore", "a.txt"]);
  expect(
    (await git.statusMatrix({ fs, dir: "/source" })).find(([path]) => path === "a.txt")?.[3],
  ).toBe(2);
  await git.remove({ fs, dir: "/source", filepath: "a.txt" });
  await ok("git add -A", "/source");
  expect(await git.listFiles({ fs, dir: "/source" })).toEqual([".gitignore"]);
});

it("refreshes missing ignore files between commands and keeps nested rules scoped", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  vfs.mkdir("/source/one");
  vfs.mkdir("/source/two");
  await vfs.writeFile("/source/one/first", "1");
  await ok("git add -A", "/source");
  await vfs.writeFile("/source/one/.gitignore", "skip\n");
  await vfs.writeFile("/source/.git/info/exclude", "excluded\n");
  await vfs.writeFile("/source/one/skip", "ignored");
  await vfs.writeFile("/source/two/skip", "included");
  await vfs.writeFile("/source/excluded", "ignored");
  await ok("git add -A", "/source");
  expect(await git.listFiles({ fs, dir: "/source" })).toEqual([
    "a.txt",
    "one/.gitignore",
    "one/first",
    "two/skip",
  ]);
  vfs.remove("/source/one/.gitignore");
  await vfs.writeFile("/source/.git/info/exclude", "");
  await ok("git add -A", "/source");
  expect(await git.listFiles({ fs, dir: "/source" })).toEqual([
    "a.txt",
    "excluded",
    "one/first",
    "one/skip",
    "two/skip",
  ]);
});

it("preserves existing Git file modes and applies nondefault creation umasks", async () => {
  const { seed, ok, vfs, shell } = fixture();
  await seed();
  vfs.setMetadata("/source/.git/config", { mode: 0o100600 });
  vfs.setMetadata("/source/.git/index", { mode: 0o100600 });
  await ok("git config user.name Changed", "/source");
  await vfs.writeFile("/source/a.txt", "updated\n");
  await ok("git add a.txt", "/source");
  expect(vfs.stat("/source/.git/config").mode & 0o777).toBe(0o600);
  expect(vfs.stat("/source/.git/index").mode & 0o777).toBe(0o600);
  expect((await shell.executeText({ script: "git init /private", umask: 0o077 })).exitCode).toBe(0);
  expect(vfs.stat("/private/.git/HEAD").mode & 0o777).toBe(0o600);
  expect((await shell.executeText({ script: "git init /group", umask: 0o002 })).exitCode).toBe(0);
  expect(vfs.stat("/group/.git/HEAD").mode & 0o777).toBe(0o664);
});

it("clones four multi-megabyte files within the default shell I/O budget", async () => {
  const { seed, fs, vfs, ok } = fixture();
  await seed();
  const names = Array.from({ length: 4 }, (_, index) => `large-${index}`);
  for (const [index, name] of names.entries())
    await vfs.writeFile(`/source/${name}`, new Uint8Array(3 * 1024 * 1024).fill(index + 1));
  await git.add({ fs, dir: "/source", filepath: names });
  await git.commit({
    fs,
    dir: "/source",
    message: "large files",
    author: {
      name: "test",
      email: "test@example.invalid",
    },
  });
  await ok("git clone /source /large-copy");
  for (const [index, name] of names.entries()) {
    const body = await fs.promises.readFile(`/large-copy/${name}`);
    expect(body.byteLength).toBe(3 * 1024 * 1024);
    expect(body.every((value) => value === index + 1)).toBe(true);
  }
});

it("leaves HEAD and index unchanged for an up-to-date pull while rejecting dirty trees", async () => {
  const { seed, ok, run, vfs } = fixture();
  await seed();
  await ok("git clone --bare /source /remote.git; git clone /remote.git /copy");
  const head = vfs.getMutationToken("/copy/.git/HEAD");
  const index = vfs.getMutationToken("/copy/.git/index");
  await ok("git pull --ff-only origin main", "/copy");
  expect(vfs.getMutationToken("/copy/.git/HEAD")).toBe(head);
  expect(vfs.getMutationToken("/copy/.git/index")).toBe(index);
  await vfs.writeFile("/copy/a.txt", "dirty\n");
  const refused = await run("git pull --ff-only origin main", "/copy");
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("clean working tree");
  expect(vfs.getMutationToken("/copy/.git/HEAD")).toBe(head);
});

it("restages CRLF bytes when autocrlf configuration changes", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  await vfs.writeFile("/source/a.txt", "line\r\n");
  await ok(
    "git add a.txt; git commit -m crlf; git config core.autocrlf true; git add a.txt; git commit -m normalize",
    "/source",
  );
  const oid = await git.resolveRef({ fs, dir: "/source", ref: "HEAD" });
  const { blob } = await git.readBlob({ fs, dir: "/source", oid, filepath: "a.txt" });
  expect(new TextDecoder().decode(blob)).toBe("line\n");
});

it("stages 1,000 deletions within the default execution I/O budget", async () => {
  const { ok, vfs, fs } = fixture();
  await ok("git init /source");
  const paths = Array.from({ length: 1000 }, (_, i) => `f${i}`);
  for (const path of paths) await vfs.writeFile(`/source/${path}`, "body\n");
  for (let start = 0; start < paths.length; start += 32)
    await git.add({ fs, dir: "/source", filepath: paths.slice(start, start + 32) });
  for (const path of paths) vfs.remove(`/source/${path}`);
  await ok("git add -A", "/source");
  expect(await git.listFiles({ fs, dir: "/source" })).toEqual([]);
});

it("rejects object-store symlinks without reading their targets during local clone", async () => {
  const { ok, run, vfs } = fixture();
  await ok("git init /source");
  vfs.mkdir("/source/.git/objects/aa");
  await vfs.writeFile("/secret", "private bytes");
  vfs.symlink("/source/.git/objects/aa/object", "/secret");
  const read = vi.spyOn(vfs, "readFile");
  const result = await run("git clone --bare /source /copy");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("symbolic links in object storage");
  expect(read.mock.calls.some(([path]) => path === "/secret" || path.endsWith("/aa/object"))).toBe(
    false,
  );
});

it("checks object read permissions when cloning from directory metadata", async () => {
  const { seed, vfs, shell } = fixture();
  await seed();
  vfs.mkdir("/copies", false, 0o40777);
  vfs.mkdir("/source/.git/objects/aa", true);
  await vfs.writeFile("/source/.git/objects/aa/private", "private object", { mode: 0o100000 });
  const result = await shell.executeText({
    script: "git clone --bare /source /copies/denied",
    credentials: { uid: 1000, gid: 1000 },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/permission|EACCES/iu);
  expect(() => vfs.stat("/copies/denied/objects/aa/private")).toThrow();
});

it("does not register Git in the default shell", async () => {
  const vfs = createTestFileSystem();
  const shell = new Shell({ fileSystem: vfs, commands: defaultShellCommands });
  expect((await shell.executeText({ script: "git init /repo" })).exitCode).toBe(127);
  expect(() => vfs.stat("/repo")).toThrow();
});

it("stages, commits, diffs, logs and switches branches using VFS bytes", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  await vfs.writeFile("/source/a.txt", "later\n");
  expect((await ok("git status --porcelain", "/source")).stdout).toContain(' M "a.txt"');
  expect((await ok("git diff", "/source")).stdout).toContain("+later");
  await ok("git checkout -b feature; git add .", "/source");
  expect((await ok("git diff --cached", "/source")).stdout).toContain("+later");
  await ok("git commit -m changed", "/source");
  expect((await ok("git status --short", "/source")).stdout).toBe("");
  expect((await ok("git log --oneline -n 2", "/source")).stdout).toContain("initial");
  await ok("git checkout main", "/source");
  expect(await fs.promises.readFile("/source/a.txt", "utf8")).toBe("first\n");
  await ok("git checkout feature", "/source");
  expect(await fs.promises.readFile("/source/a.txt", "utf8")).toBe("later\n");
});

it("clones committed history, branches, tags and binary bytes without copying uncommitted files", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  await vfs.writeFile("/source/data.bin", new Uint8Array([0, 255, 17]));
  await ok("git add data.bin; git commit -m binary; git branch feature", "/source");
  await git.tag({ fs, dir: "/source", ref: "v1" });
  await vfs.writeFile("/source/untracked", "private working data");
  await vfs.writeFile("/source/a.txt", "uncommitted\n");
  await ok("git clone /source /copy");
  expect(await fs.promises.readFile("/copy/a.txt", "utf8")).toBe("first\n");
  expect(await fs.promises.readFile("/copy/data.bin")).toEqual(new Uint8Array([0, 255, 17]));
  expect(() => vfs.stat("/copy/untracked")).toThrow();
  expect(await git.listBranches({ fs, dir: "/copy", remote: "origin" })).toContain("feature");
  expect(await git.listTags({ fs, dir: "/copy" })).toEqual(["v1"]);
  expect(await git.resolveRef({ fs, dir: "/copy", ref: "HEAD" })).toBe(
    await git.resolveRef({ fs, dir: "/source", ref: "HEAD" }),
  );
});

it("supports bare local clone, push, fetch and fast-forward pull", async () => {
  const { seed, ok, vfs, fs } = fixture();
  await seed();
  await ok("git clone --bare /source /remote.git; git clone /remote.git /copy");
  await ok("git config user.name Tester; git config user.email tester@example.com", "/copy");
  await vfs.writeFile("/copy/a.txt", "pushed\n");
  await ok("git add .; git commit -m pushed; git push -u origin main", "/copy");
  const pushed = (await ok("git rev-parse HEAD", "/copy")).stdout.trim();
  expect(await git.resolveRef({ fs, dir: "/remote.git", gitdir: "/remote.git", ref: "HEAD" })).toBe(
    pushed,
  );
  await ok("git remote add upstream /remote.git; git fetch upstream", "/source");
  expect(await fs.promises.readFile("/source/a.txt", "utf8")).toBe("first\n");
  await ok("git pull --ff-only upstream main", "/source");
  expect(await fs.promises.readFile("/source/a.txt", "utf8")).toBe("pushed\n");
});

it("rejects non-fast-forward pushes without changing the remote reference", async () => {
  const { seed, ok, run, vfs } = fixture();
  await seed();
  await ok(
    "git clone --bare /source /remote.git; git clone /remote.git /one; git clone /remote.git /two",
  );
  for (const dir of ["/one", "/two"]) {
    await ok("git config user.name Tester; git config user.email tester@example.com", dir);
    await vfs.writeFile(`${dir}/a.txt`, `${dir}\n`);
    await ok("git add .; git commit -m divergence", dir);
  }
  await ok("git push origin main", "/one");
  const before = (await ok("git rev-parse HEAD", "/remote.git")).stdout;
  expect((await run("git push origin main", "/two")).exitCode).not.toBe(0);
  expect((await ok("git rev-parse HEAD", "/remote.git")).stdout).toBe(before);
});

it("protects dirty checkouts, nonempty clone destinations and checked-out push targets", async () => {
  const { seed, ok, run, vfs, fs } = fixture();
  await seed();
  await ok("git checkout -b feature", "/source");
  await vfs.writeFile("/source/a.txt", "feature\n");
  await ok("git add .; git commit -m feature; git checkout main", "/source");
  await vfs.writeFile("/source/a.txt", "dirty\n");
  expect((await run("git checkout feature", "/source")).exitCode).not.toBe(0);
  expect(await fs.promises.readFile("/source/a.txt", "utf8")).toBe("dirty\n");
  expect((await run("git clone /source /source")).exitCode).not.toBe(0);
  await ok("git clone /source /copy");
  expect((await run("git push origin main", "/copy")).exitCode).not.toBe(0);
});

it("resolves -C and local file URLs without changing shell cwd", async () => {
  const { seed, ok } = fixture();
  await seed();
  await ok("git clone file:///source /copy");
  expect((await ok("git -C /copy log --oneline; pwd")).stdout).toContain("initial\n/\n");
});

it("uses shell read/write roots for Git and local transport", async () => {
  const { vfs, seed } = fixture();
  await seed();
  vfs.mkdir("/allowed");
  const shell = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    policy: { readRoots: ["/allowed"], writeRoots: ["/allowed"] },
  });
  const denied = await shell.executeText({
    script: "git clone /source /allowed/copy",
    cwd: "/allowed",
  });
  expect(denied.exitCode).not.toBe(0);
  expect(() => vfs.stat("/allowed/copy")).toThrow();
  vfs.symlink("/allowed/escape", "/source");
  expect(
    (
      await shell.executeText({
        script: "git clone /allowed/escape /allowed/copy",
        cwd: "/allowed",
      })
    ).exitCode,
  ).not.toBe(0);
});

it("rejects network URLs and unknown options without starting a clone", async () => {
  const { run, vfs } = fixture();
  for (const command of [
    "git clone https://example.com/repo /copy",
    "git clone --depth 1 /repo /copy",
  ]) {
    expect((await run(command)).exitCode).not.toBe(0);
    expect(() => vfs.stat("/copy")).toThrow();
  }
});

it("honors mutation budgets and cancellation", async () => {
  const { vfs } = fixture();
  const shell = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    limits: { maxMutations: 1 },
  });
  expect((await shell.executeText({ script: "git init /limited" })).exitCode).not.toBe(0);
  const controller = new AbortController();
  controller.abort();
  expect(
    (await shell.executeText({ script: "git init /cancelled", signal: controller.signal }))
      .exitCode,
  ).not.toBe(0);
  expect(() => vfs.stat("/cancelled")).toThrow();
});

it("stages removals and ignores new ignored files while preserving tracked ignored files", async () => {
  const { seed, ok, vfs } = fixture();
  await seed();
  await vfs.writeFile("/source/.gitignore", "*.txt\nignored\n");
  await vfs.writeFile("/source/ignored", "skip");
  await vfs.writeFile("/source/a.txt", "later\n");
  await ok("git add -A; git commit -m tracked", "/source");
  expect((await ok("git status --porcelain", "/source")).stdout).toBe("");
  vfs.remove("/source/a.txt");
  await ok("git add -A", "/source");
  expect((await ok("git status --porcelain", "/source")).stdout).toContain('D  "a.txt"');
  await ok("git commit -m removed", "/source");
  expect((await ok("git status --porcelain", "/source")).stdout).toBe("");
});

it("preserves symbolic links and executable modes in local clones", async () => {
  const { seed, ok, vfs } = fixture();
  await seed();
  vfs.symlink("/source/link", "a.txt");
  await vfs.writeFile("/source/script", "#!/bin/sh\n", { mode: 0o100755 });
  await ok("git add link script; git commit -m modes", "/source");
  await ok("git clone /source /copy");
  expect(vfs.readlink("/copy/link")).toBe("a.txt");
  expect(vfs.stat("/copy/script").mode & 0o777).toBe(0o755);
});

it("clones empty, bare and detached repositories and rejects nonexistent branches before writing", async () => {
  const { seed, ok, run, vfs } = fixture();
  await ok("git init --bare /empty.git; git clone /empty.git /empty");
  expect((await ok("git status", "/empty")).stdout).toBe("");
  await seed();
  const oid = (await ok("git rev-parse HEAD", "/source")).stdout.trim();
  await ok(`git checkout ${oid}`, "/source");
  await ok("git clone /source /detached");
  expect((await ok("git rev-parse HEAD", "/detached")).stdout.trim()).toBe(oid);
  expect((await run("git clone -b absent /source /bad")).exitCode).not.toBe(0);
  expect(() => vfs.stat("/bad")).toThrow();
});

it("rejects dirty and diverged pulls without advancing the current branch", async () => {
  const { seed, ok, run, vfs } = fixture();
  await seed();
  await ok("git clone --bare /source /remote.git; git clone /remote.git /copy");
  const before = (await ok("git rev-parse HEAD", "/copy")).stdout;
  await vfs.writeFile("/copy/a.txt", "dirty\n");
  expect((await run("git pull origin main", "/copy")).exitCode).not.toBe(0);
  expect((await ok("git rev-parse HEAD", "/copy")).stdout).toBe(before);
});

it("publishes new nested branches to bare local remotes", async () => {
  const { seed, ok } = fixture();
  await seed();
  await ok("git clone --bare /source /remote.git; git remote add origin /remote.git", "/source");
  await ok("git branch feature/new; git push origin feature/new", "/source");
  expect((await ok("git rev-parse feature/new", "/remote.git")).stdout).toBe(
    (await ok("git rev-parse HEAD", "/source")).stdout,
  );
});

it("supports a repository at the VFS root", async () => {
  const { ok, vfs } = fixture();
  await ok("git init; git config user.name Tester; git config user.email test@example.com");
  await vfs.writeFile("/a", "root\n");
  await ok("git add a; git commit -m root");
  expect((await ok("git status --porcelain")).stdout).toBe("");
});

it("reads status without write permission and rejects worktree commands on bare repositories", async () => {
  const { seed, ok, run, vfs } = fixture();
  await seed();
  const shell = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    policy: { readRoots: ["/source"], writeRoots: [] },
  });
  expect(
    (await shell.executeText({ script: "git status --porcelain", cwd: "/source" })).exitCode,
  ).toBe(0);
  await ok("git clone --bare /source /remote.git");
  expect((await run("git status", "/remote.git")).exitCode).not.toBe(0);
});
