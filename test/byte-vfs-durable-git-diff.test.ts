import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";

it("diff skips unchanged stored bodies and retains quick edits under I/O limits on workerd", async () => {
  const outcomes = await runInDurableObject(
    env.VFS_TEST.getByName("git-diff-bounded"),
    async (_instance, state) => {
      const vfs = new DurableObjectFileSystem(state.storage);
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
      const initial = await run("git add -A && git commit -m initial");
      if (initial.exitCode !== 0) throw new Error(initial.stderr);
      const cached = new Shell({
        fileSystem: vfs,
        commands: [gitCommand],
        limits: { maxTotalIoBytes: 256 * 1024 },
      });
      const clean = await cached.executeText({ script: "git diff --cached", cwd: "/repo" });
      await vfs.writeFile("/repo/f0", "edited\n");
      const work = new Shell({
        fileSystem: vfs,
        commands: [gitCommand],
        limits: { maxTotalIoBytes: 1024 * 1024 },
      });
      const changed = await work.executeText({ script: "git diff", cwd: "/repo" });
      return { clean, changed };
    },
  );
  expect(outcomes.clean.exitCode, outcomes.clean.stderr).toBe(0);
  expect(outcomes.clean.stdout).toBe("");
  expect(outcomes.changed.exitCode, outcomes.changed.stderr).toBe(0);
  expect(outcomes.changed.stdout).toContain("+edited");
  expect(outcomes.changed.stdout.match(/diff --git/g)).toHaveLength(1);
});
