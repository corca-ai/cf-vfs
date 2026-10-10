import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as git from "isomorphic-git";
import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import type { TestWorkspaceVfs } from "./worker.js";

it("stages mixed small and large bodies through bounded batches on workerd", async () => {
  const verified = await runInDurableObject(
    env.VFS_TEST.getByName("git-mixed-staging"),
    async (_instance, state) => {
      const vfs = new DurableObjectFileSystem(state.storage);
      const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
      const run = async (script: string) => {
        const result = await shell.executeText({ script, cwd: "/repo" });
        if (result.exitCode !== 0) throw new Error(result.stderr);
      };
      vfs.mkdir("/repo");
      await run("git init; git config user.name Test; git config user.email test@example.invalid");
      for (let n = 0; n < 340; n++)
        await vfs.writeFile(
          `/repo/f${String(n).padStart(3, "0")}`,
          new Uint8Array(n < 300 ? 800 : 128 * 1024).fill(n),
        );
      await run("git add -A; git commit -m mixed");
      const index = vfs.getMutationToken("/repo/.git/index");
      await run("git add -A");
      expect(vfs.getMutationToken("/repo/.git/index")).toBe(index);
      const fs = createFsAdapter(vfs);
      const oid = await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" });
      const { tree } = await git.readTree({ fs, dir: "/repo", oid });
      for (const [n, entry] of tree.entries()) {
        const { blob } = await git.readBlob({ fs, dir: "/repo", oid: entry.oid });
        expect(blob.byteLength).toBe(n < 300 ? 800 : 128 * 1024);
        expect(blob.every((byte) => byte === n % 256)).toBe(true);
      }
      return tree.length;
    },
  );
  expect(verified).toBe(340);
});

it("runs local Git clone, push and pull against Durable Object SQLite", async () => {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName("git-local-transport");
  const result = await runInDurableObject(stub, async (_instance, state) => {
    const vfs = new DurableObjectFileSystem(state.storage);
    const shell = new Shell({ fileSystem: vfs, commands: [...defaultShellCommands, gitCommand] });
    const run = async (script: string, cwd = "/") => {
      const outcome = await shell.executeText({ script, cwd });
      if (outcome.exitCode !== 0) throw new Error(`${script}: ${outcome.stderr}`);
    };
    await run("git init /source");
    await run("git config user.name Tester; git config user.email test@example.com", "/source");
    await vfs.writeFile("/source/a", "before\n");
    await run("git add a; git commit -m before", "/source");
    await run("git clone --bare /source /remote.git; git clone /remote.git /copy");
    await run("git config user.name Tester; git config user.email test@example.com", "/copy");
    await vfs.writeFile("/copy/a", "after!\n");
    const status = await shell.executeText({ script: "git status --porcelain", cwd: "/copy" });
    await run("git add .; git commit -m after; git push origin main", "/copy");
    await run("git remote add upstream /remote.git; git pull upstream main", "/source");
    const fs = createFsAdapter(vfs);
    return { status: status.stdout, body: await fs.promises.readFile("/source/a", "utf8") };
  });
  expect(result).toEqual({ status: ' M "a"\n', body: "after!\n" });
});

it("clones four 3 MiB files with default budgets on workerd", async () => {
  const result = await runInDurableObject(
    env.VFS_TEST.getByName("git-large-local-clone"),
    async (_instance, state) => {
      const vfs = new DurableObjectFileSystem(state.storage);
      const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
      const run = async (script: string, cwd = "/") => {
        const outcome = await shell.executeText({ script, cwd });
        if (outcome.exitCode !== 0) throw new Error(`${script}: ${outcome.stderr}`);
      };
      await run("git init /source");
      await run(
        "git config user.name Large; git config user.email large@example.invalid",
        "/source",
      );
      for (let index = 0; index < 4; index++)
        await vfs.writeFile(`/source/f${index}`, new Uint8Array(3 * 1024 * 1024).fill(index + 1));
      await run("git add -A", "/source");
      await run("git commit -m large", "/source");
      await run("git clone /source /copy");
      const fs = createFsAdapter(vfs);
      const verified = [];
      for (let index = 0; index < 4; index++) {
        const body = await fs.promises.readFile(`/copy/f${index}`);
        verified.push(
          body.byteLength === 3 * 1024 * 1024 && body.every((value) => value === index + 1),
        );
      }
      return verified;
    },
  );
  expect(result).toEqual([true, true, true, true]);
});
