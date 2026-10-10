import * as git from "isomorphic-git";
import { createFsAdapter } from "../../src/fs/index.js";
import { gitCommand } from "../../src/shell/commands/git.js";
import { Shell } from "../../src/shell/shell.js";
import type { VirtualFileSystem } from "../../src/vfs/types.js";

/** Uses the backend's real dynamic logical-byte quota, without mocked writes. */
export async function verifyGitQuotaRecovery(
  vfs: VirtualFileSystem,
  limit: (bytes: number) => void,
) {
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script: string) => shell.executeText({ script, cwd: "/quota" });
  await shell.executeText({ script: "git init /quota" });
  await vfs.writeFile("/quota/seed", "seed");
  if ((await run("git add seed")).exitCode !== 0) throw new Error("Seed staging failed");
  const fs = createFsAdapter(vfs);
  const before = await fs.promises.readFile("/quota/.git/index");
  for (let n = 0; n < 32; n++) await vfs.writeFile(`/quota/new${n}`, `quota body ${n}`);
  limit(1);
  const failed = await run("git add -A");
  if (failed.exitCode === 0 || !failed.stderr.includes("quota exceeded"))
    throw new Error(`Quota did not reject add: ${failed.stderr}`);
  const after = await fs.promises.readFile("/quota/.git/index");
  if (after.length !== before.length || !after.every((byte, n) => byte === before[n]))
    throw new Error("Quota changed the index");
  limit(32 * 1024 * 1024);
  if ((await run("git add -A")).exitCode !== 0) throw new Error("Quota retry failed");
  return (await git.listFiles({ fs, dir: "/quota" })).length;
}
