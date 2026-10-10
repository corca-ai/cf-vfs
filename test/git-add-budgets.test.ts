import { expect, it } from "vitest";
import { defineApplet } from "../src/shell/commands/applet.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { GitFileSystem } from "../src/shell/commands/git-fs.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("charges original configuration bytes even when UTF-8 decoding replaces an invalid byte", async () => {
  const vfs = createTestFileSystem();
  vfs.mkdir("/repo/.git", true);
  await vfs.writeFile("/repo/.git/config", Uint8Array.of(35, 255, 10));
  const probe = defineApplet(
    { name: "probe", usage: "", summary: "reads test configuration" },
    async (context) => {
      const fs = new GitFileSystem(context);
      fs.coalesceConfigReads("/repo/.git");
      const values = await Promise.all(
        Array.from({ length: 200 }, () => fs.promises.readFile("/repo/.git/config", "utf8")),
      );
      expect(values.every((value) => value === "#\uFFFD\n")).toBe(true);
      return 0;
    },
  );
  for (const [limit, expected] of [
    [600, 0],
    [599, 1],
  ] as const) {
    const shell = new Shell({
      fileSystem: vfs,
      commands: [probe],
      limits: { maxTotalIoBytes: limit },
    });
    expect((await shell.executeText({ script: "probe" })).exitCode).toBe(expected);
  }
});

it("counts every coalesced configuration reader against the shell I/O limit", async () => {
  const vfs = createTestFileSystem();
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = async (script: string, cwd = "/repo") => {
    const result = await shell.executeText({ script, cwd });
    expect(result.exitCode, result.stderr).toBe(0);
  };
  await run("git init /repo", "/");
  await run("git config user.name Test; git config user.email test@example.invalid");
  for (let n = 0; n < 200; n++) await vfs.writeFile(`/repo/f${n}`, "tracked\n");
  await run("git add -A; git commit -m tracked");
  await vfs.appendFile("/repo/.git/config", `\n#${"x".repeat(4096)}\n`);
  const index = vfs.getMutationToken("/repo/.git/index");
  const refusedLimits: string[] = [];
  const bounded = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    limits: { maxTotalIoBytes: 128 * 1024 },
    onEvent: (event) => {
      if (event.type === "shell.limit") refusedLimits.push(event.limit);
    },
  });
  const result = await bounded.executeText({ script: "git add -A", cwd: "/repo" });
  expect(result.exitCode).toBe(1);
  expect(refusedLimits).toContain("maxTotalIoBytes");
  expect(vfs.getMutationToken("/repo/.git/index")).toBe(index);
  // A failed execution cannot poison the next command's configuration reads.
  await run("git add -A");
});
