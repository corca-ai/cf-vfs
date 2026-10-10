import * as git from "isomorphic-git";
import { expect, it } from "vitest";
import { runCheckoutRecovery } from "../demo/benchmark-git-checkout-recovery.js";
import { createFsAdapter } from "../src/fs/index.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("recovers a partial checkout entirely through the Git applet", async () => {
  expect((await runCheckoutRecovery(createTestFileSystem())).verified).toBe(100);
});
it.each(["--force", "-f"])(
  "explicit checkout %s discards tracked changes and preserves unrelated untracked files",
  async (flag) => {
    const vfs = createTestFileSystem();
    const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
    const run = (script: string) => shell.executeText({ script, cwd: "/repo" });
    await shell.executeText({ script: "git init /repo" });
    await run("git config user.name Test; git config user.email test@example.invalid");
    await vfs.writeFile("/repo/a", "committed\n");
    await run("git add a && git commit -m initial");
    await vfs.writeFile("/repo/a", "dirty\n");
    await vfs.writeFile("/repo/untracked", "keep\n");
    expect((await run("git checkout main")).exitCode).toBe(1);
    const result = await run(`git checkout ${flag} main`);
    expect(result.exitCode, result.stderr).toBe(0);
    const fs = createFsAdapter(vfs);
    expect(await fs.promises.readFile("/repo/a", "utf8")).toBe("committed\n");
    expect(await fs.promises.readFile("/repo/untracked", "utf8")).toBe("keep\n");
    expect(await git.listFiles({ fs, dir: "/repo" })).toEqual(["a"]);
  },
);

it("force checkout replaces a changed symlink without following its target", async () => {
  const vfs = createTestFileSystem();
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script: string) => shell.executeText({ script, cwd: "/repo" });
  await shell.executeText({ script: "git init /repo" });
  await run("git config user.name Test; git config user.email test@example.invalid");
  await vfs.writeFile("/repo/a", "committed\n");
  await run("git add a && git commit -m initial");
  await vfs.writeFile("/outside", "keep outside\n");
  await vfs.remove("/repo/a");
  vfs.symlink("/repo/a", "/outside");
  const result = await run("git checkout --force main");
  expect(result.exitCode, result.stderr).toBe(0);
  const fs = createFsAdapter(vfs);
  expect(vfs.lstat("/repo/a").kind).toBe("file");
  expect(await fs.promises.readFile("/repo/a", "utf8")).toBe("committed\n");
  expect(await fs.promises.readFile("/outside", "utf8")).toBe("keep outside\n");
});

it("force checkout replaces an untracked path obstructing the selected tree", async () => {
  const vfs = createTestFileSystem();
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script: string) => shell.executeText({ script, cwd: "/repo" });
  await shell.executeText({ script: "git init /repo" });
  await run("git config user.name Test; git config user.email test@example.invalid");
  await vfs.writeFile("/repo/a", "base\n");
  await run("git add a && git commit -m base && git branch base");
  await vfs.writeFile("/repo/added", "tracked\n");
  await run("git add added && git commit -m added && git checkout base");
  await vfs.writeFile("/repo/added", "untracked obstruction\n");
  const result = await run("git checkout --force main");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(await createFsAdapter(vfs).promises.readFile("/repo/added", "utf8")).toBe("tracked\n");
  expect((await run("git status --porcelain")).stdout).toBe("");
});
