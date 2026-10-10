import * as git from "isomorphic-git";
import { expect, it } from "vitest";
import { benchmarkGitCommand } from "../demo/benchmark-git-command.js";
import { createFsAdapter } from "../src/fs/index.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("makes comparison commit identities independent of filesystem wall time", async () => {
  const identities = [];
  for (const time of [1000000000000, 1800000000000]) {
    const vfs = createTestFileSystem({ now: () => time });
    const shell = new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(1700000000000)] });
    const init = await shell.executeText({ script: "git init /repo" });
    expect(init.exitCode, init.stderr).toBe(0);
    await vfs.writeFile("/repo/a", "hello\n");
    const result = await shell.executeText({
      cwd: "/repo",
      script:
        "git config user.name Test; git config user.email test@example.invalid; git add -A && git commit -m initial",
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const oid = result.stdout.trim();
    const commit = await git.readCommit({ fs: createFsAdapter(vfs), dir: "/repo", oid });
    expect(commit.commit.author.timestamp).toBe(1700000000);
    expect(commit.commit.committer.timestamp).toBe(1700000000);
    identities.push(oid);
  }
  expect(identities[0]).toBe(identities[1]);
});
