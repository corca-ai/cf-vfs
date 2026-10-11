import { expect, it, vi } from "vitest";
import { CollaborativeFileSystem, DocumentRegistry } from "../src/collab/index.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { createTrackedGitCommand } from "../src/shell/commands/git-tracked.js";
import { Shell } from "../src/shell/shell.js";
import type { ExecuteTextOptions } from "../src/shell/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function fixture(tracked = true, recordChanges = true) {
  const fs = createTestFileSystem({ recordChanges, now: () => 1000 });
  const command = tracked ? createTrackedGitCommand(fs) : gitCommand;
  const shell = new Shell({ fileSystem: fs, commands: [command], now: () => 1000 });
  const run = (script: string, options: Partial<ExecuteTextOptions> = {}) =>
    shell.executeText({ script, cwd: "/repo", ...options });
  const ok = async (script: string) => {
    const result = await run(script);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  expect((await shell.executeText({ script: "git init /repo" })).exitCode).toBe(0);
  await ok("git config user.name Test; git config user.email test@example.invalid");
  for (let i = 0; i < 100; i++)
    await fs.writeFile(`/repo/d${i}/f`, "base\n", { createParents: true });
  await ok("git add .; git commit -m initial; git add .");
  return { fs, shell, command, run, ok };
}

it("stages only changed branches after a successful complete add", async () => {
  const { fs, ok } = await fixture();
  const reads = vi.spyOn(fs, "readFile");
  await fs.writeFile("/repo/d0/f", "next\n");
  await ok("git add .");
  expect(reads.mock.calls.some(([path]) => path === "/repo/d99/f")).toBe(false);
  expect(await ok("git status --short")).toBe('M  "d0/f"\n');
  expect(await ok("git diff --cached")).toContain("+next");
});

for (const change of [
  "delete",
  "move-directory",
  "mode",
  "ignore",
  "index",
  "symlink",
  "head",
] as const) {
  it(`matches full staging after ${change}`, async () => {
    const plain = await fixture(false),
      tracked = await fixture();
    for (const f of [plain, tracked]) {
      await changeFixture(change, f);
      await f.ok("git add .");
    }
    expect(await tracked.ok("git status --short")).toBe(await plain.ok("git status --short"));
    const blocks = (s: string) => s.split(/(?=^diff --git )/m).sort();
    expect(blocks(await tracked.ok("git diff --cached"))).toEqual(
      blocks(await plain.ok("git diff --cached")),
    );
  });
}

async function changeFixture(change: string, f: Awaited<ReturnType<typeof fixture>>) {
  if (change === "delete") await f.fs.remove("/repo/d0/f");
  if (change === "move-directory") await f.fs.move("/repo/d0", "/repo/moved");
  if (change === "mode") f.fs.setMetadata("/repo/d0/f", { mode: 0o100755 });
  if (change === "ignore") {
    await f.fs.writeFile("/repo/ignored", "new\n");
    await f.fs.writeFile("/repo/.gitignore", "ignored\n");
  }
  if (change === "index") {
    await f.fs.writeFile("/repo/d0/f", "staged\n");
    await f.ok("git add d0/f");
    await f.fs.writeFile("/repo/d1/f", "other\n");
  }
  if (change === "symlink") {
    await f.fs.remove("/repo/d0/f");
    f.fs.symlink("/repo/d0/f", "../d1/f");
  }
  if (change === "head") {
    await f.ok("git commit --allow-empty -m checkpoint");
    await f.fs.writeFile("/repo/d1/f", "other\n");
  }
}

it("does not turn a successful root add into authorization for another principal", async () => {
  const { fs, run } = await fixture();
  fs.setMetadata("/repo/d99/f", { mode: 0o100000 });
  const result = await run("git add .", { credentials: { uid: 1000, gid: 1000 } });
  expect(result.exitCode).not.toBe(0);
  const plain = new Shell({ fileSystem: fs, commands: [gitCommand] });
  expect(result).toEqual(
    await plain.executeText({
      script: "git add .",
      cwd: "/repo",
      credentials: { uid: 1000, gid: 1000 },
    }),
  );
});

it("rechecks unchanged branches after ancestor permissions change", async () => {
  const { fs, run, ok } = await fixture();
  await ok("git add .");
  fs.setMetadata("/repo/d99", { mode: 0o40000 });
  const result = await run("git add .", { credentials: { uid: 1000, gid: 1000 } });
  expect(result.exitCode).not.toBe(0);
});

it("falls back when change recording is absent or the supplied host owns another filesystem", async () => {
  const a = await fixture(true, false);
  await a.fs.writeFile("/repo/d0/f", "next\n");
  await a.ok("git add .");
  expect(await a.ok("git status --short")).toContain('M  "d0/f"');
  const b = await fixture();
  const shell = new Shell({ fileSystem: b.fs, commands: [a.command] });
  await b.fs.writeFile("/repo/d0/f", "other\n");
  expect((await shell.executeText({ script: "git add .", cwd: "/repo" })).exitCode).toBe(0);
  expect(await b.ok("git status --short")).toContain('M  "d0/f"');
});

it("does not reuse a checkpoint across a different shell policy", async () => {
  const { fs, command } = await fixture();
  const shell = new Shell({
    fileSystem: fs,
    commands: [command],
    policy: { readRoots: ["/repo/.git", "/repo/d0"] },
  });
  expect((await shell.executeText({ script: "git add .", cwd: "/repo" })).exitCode).not.toBe(0);
});

it("uses the full path when a wrapper refuses bulk source semantics", async () => {
  const { fs } = await fixture();
  const view = new CollaborativeFileSystem(fs, new DocumentRegistry());
  const command = createTrackedGitCommand(view);
  const shell = new Shell({ fileSystem: view, commands: [command] });
  const run = () => shell.executeText({ script: "git add .", cwd: "/repo" });
  expect((await run()).exitCode).toBe(0);
  vi.spyOn(view, "canUseBulkOperation").mockReturnValue(false);
  await fs.writeFile("/repo/d0/f", "next\n");
  const read = vi.spyOn(view, "readFile");
  expect((await run()).exitCode).toBe(0);
  expect(read.mock.calls.some(([path]) => path === "/repo/d99/f")).toBe(true);
});

it("keeps the checkpoint through a commit of the unchanged index", async () => {
  const { fs, ok } = await fixture();
  for (let turn = 0; turn < 3; turn++) {
    await fs.writeFile("/repo/d0/f", `edit ${turn}\n`);
    const read = vi.spyOn(fs, "readFile");
    await ok("git add .");
    expect(read.mock.calls.some(([path]) => path === "/repo/d99/f")).toBe(false);
    read.mockRestore();
    await ok(`git commit -m round${turn}`);
  }
  expect(await ok("git status --short")).toBe("");
});

it("invalidates dependencies reached through a symlink outside the repository", async () => {
  const { fs, ok } = await fixture();
  await fs.writeFile("/ignore-rules", "hidden\n");
  fs.symlink("/repo/.gitignore", "/ignore-rules");
  await fs.writeFile("/repo/hidden", "hidden body\n");
  await ok("git add .");
  expect(await ok("git status --short")).not.toContain('"hidden"');
  await fs.writeFile("/ignore-rules", "");
  await ok("git add .");
  expect(await ok("git status --short")).toContain('A  "hidden"');
});

it("discards a checkpoint when staging fails before publishing the index", async () => {
  const { fs, run, ok } = await fixture();
  await fs.writeFile("/repo/d0/f", "next\n");
  const write = fs.writeFile.bind(fs);
  const injected = vi.spyOn(fs, "writeFile").mockImplementation((path, body, options) => {
    if (path === "/repo/.git/index") return Promise.reject(new Error("injected index failure"));
    return write(path, body, options);
  });
  expect((await run("git add .")).exitCode).not.toBe(0);
  injected.mockRestore();
  const read = vi.spyOn(fs, "readFile");
  await ok("git add .");
  expect(read.mock.calls.some(([path]) => path === "/repo/d99/f")).toBe(true);
  expect(await ok("git status --short")).toBe('M  "d0/f"\n');
});

it("uses a full walk for a large change set", async () => {
  const { fs, ok } = await fixture();
  for (let i = 0; i < 130; i++) await fs.writeFile(`/repo/new${i}`, "new\n");
  const read = vi.spyOn(fs, "readFile");
  await ok("git add .");
  expect(read.mock.calls.some(([path]) => path === "/repo/d99/f")).toBe(true);
  expect((await ok("git status --short")).trimEnd().split("\n")).toHaveLength(130);
});

it("silently skips a newly changed ignored file during whole-tree staging", async () => {
  const { fs, ok } = await fixture();
  await fs.writeFile("/repo/.gitignore", "hidden\n");
  await ok("git add .; git commit -m ignore");
  await fs.writeFile("/repo/hidden", "not staged\n");
  await ok("git add .");
  expect(await ok("git status --short")).toBe("");
});

it("rechecks ignore rules reached through a symlink inside the repository", async () => {
  const { fs, ok } = await fixture();
  await fs.writeFile("/repo/rules", "hidden\n");
  fs.symlink("/repo/.gitignore", "rules");
  await fs.writeFile("/repo/hidden", "hidden body\n");
  await ok("git add .; git commit -m ignore; git add .");
  expect(await ok("git status --short")).not.toContain('"hidden"');
  await fs.writeFile("/repo/rules", "");
  await ok("git add .");
  expect(await ok("git status --short")).toContain('A  "hidden"');
});

it("validates each -C operand before accepting an unchanged checkpoint", async () => {
  const { fs, run, ok } = await fixture();
  const plain = new Shell({ fileSystem: fs, commands: [gitCommand] });
  const script = "git -C d0/f -C /repo add .";
  const expected = await plain.executeText({ script, cwd: "/repo" });
  expect(expected.exitCode).not.toBe(0);
  expect(await run(script)).toEqual(expected);
  await fs.writeFile("/repo/d0/f", "next\n");
  await ok("git -C /repo/d0 -C .. add -A .");
  expect(await ok("git status --short")).toBe('M  "d0/f"\n');
});
