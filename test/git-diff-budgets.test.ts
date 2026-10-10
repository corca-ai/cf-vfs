import { expect, it } from "vitest";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function fixture() {
  const vfs = createTestFileSystem();
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script: string) => shell.executeText({ script, cwd: "/repo" });
  await shell.executeText({ script: "git init /repo" });
  await run("git config user.name Test; git config user.email test@example.invalid");
  for (let n = 0; n < 1000; n++) {
    let seed = n + 1;
    const body = Uint8Array.from({ length: 768 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 32 + ((seed >>> 24) % 95);
    });
    await vfs.writeFile(`/repo/f${n}`, body);
  }
  const setup = await run("git add -A && git commit -m initial");
  expect(setup.exitCode, setup.stderr).toBe(0);
  return { vfs, run };
}
it("diff --cached skips unchanged blobs within a small I/O budget", async () => {
  const { vfs } = await fixture();
  const shell = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    limits: { maxTotalIoBytes: 256 * 1024 },
  });
  const result = await shell.executeText({ script: "git diff --cached", cwd: "/repo" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
});
it("diff reads worktree bytes once and only decodes the changed stored blob", async () => {
  const { vfs } = await fixture();
  await vfs.writeFile("/repo/f0", "edited\n");
  const shell = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    limits: { maxTotalIoBytes: 1024 * 1024 },
  });
  const result = await shell.executeText({ script: "git diff", cwd: "/repo" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.match(/diff --git/g)).toHaveLength(1);
  expect(result.stdout).toContain("+edited");
});
it("diff observes same-size edits, staged bytes, binary changes and symlink targets", async () => {
  const vfs = createTestFileSystem();
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script: string) => shell.executeText({ script, cwd: "/repo" });
  await shell.executeText({ script: "git init /repo" });
  await run("git config user.name Test; git config user.email test@example.invalid");
  await vfs.writeFile("/repo/a", "before\n");
  await vfs.writeFile("/repo/binary", new Uint8Array([0, 1]));
  vfs.symlink("/repo/link", "a");
  expect((await run("git add -A && git commit -m initial")).exitCode).toBe(0);
  await vfs.writeFile("/repo/a", "after!\n");
  await vfs.writeFile("/repo/binary", new Uint8Array([0, 2]));
  await vfs.remove("/repo/link");
  vfs.symlink("/repo/link", "z");
  const diff = await run("git diff");
  expect(diff.exitCode, diff.stderr).toBe(0);
  expect(diff.stdout).toContain("+after!");
  expect(diff.stdout).toContain("Binary files differ");
  expect(diff.stdout).toContain("+z");
  await run("git add -A");
  const staged = await run("git diff --cached");
  const patches = (text: string) =>
    text
      .split(/(?=diff --git )/u)
      .filter(Boolean)
      .sort();
  expect(patches(staged.stdout)).toEqual(patches(diff.stdout));
  expect((await run("git diff")).stdout).toBe("");
});
