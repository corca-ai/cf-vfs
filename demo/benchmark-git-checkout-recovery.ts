import * as git from "isomorphic-git";
import { VfsError } from "../src/core/errors.js";
import { createFsAdapter } from "../src/fs/index.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";

/** Preserve history after a partial checkout, then repair through explicit forced checkout. */
export async function runCheckoutRecovery(vfs: VirtualFileSystem) {
  const root = "/scratch/checkout-recovery";
  const fs = createFsAdapter(vfs);
  await fs.promises.rm(root, { recursive: true, force: true });
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script: string) => shell.executeText({ script, cwd: root });
  const succeed = async (script: string) => {
    const result = await run(script);
    if (result.exitCode !== 0) throw new Error(`${script}: ${result.stderr}`);
  };
  await shell.executeText({ script: `git init ${root}` });
  await succeed("git config user.name Recovery; git config user.email recovery@example.invalid");
  for (let n = 0; n < 32; n++) await vfs.writeFile(`${root}/f${n}`, `base ${n}\n`);
  await succeed("git add -A && git commit -m base && git branch base");
  for (let n = 0; n < 32; n++) await vfs.writeFile(`${root}/f${n}`, `next ${n}\n`);
  await succeed("git add -A && git commit -m next");
  const head = await git.resolveRef({ fs, dir: root, ref: "HEAD" });
  let writes = 0;
  const wrapped = new Proxy(vfs, {
    get(target, property) {
      // This probe deliberately injects single-file failures; batch faults have a separate test.
      if (property === "forCredentials" || property === "canUseBulkOperation") return undefined;
      if (property === "writeFile")
        return async (...args: Parameters<VirtualFileSystem["writeFile"]>) => {
          if (args[0].startsWith(`${root}/f`) && ++writes === 8)
            throw new VfsError("ENOSPC", "injected checkout write failure");
          return target.writeFile(...args);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const faulty = new Shell({ fileSystem: wrapped, commands: [gitCommand] });
  if (
    (await faulty.executeText({ script: "git checkout base", cwd: root })).exitCode === 0 ||
    writes < 8
  )
    throw new Error("Checkout fault was not observed");
  if ((await git.resolveRef({ fs, dir: root, ref: "HEAD" })) !== head)
    throw new Error("Failed checkout changed HEAD");
  let changed = 0;
  for (let n = 0; n < 32; n++) {
    const body = await fs.promises.readFile(`${root}/f${n}`, "utf8");
    if (body === `base ${n}\n`) changed++;
    else if (body !== `next ${n}\n`) throw new Error("Unexpected partial checkout bytes");
    const { blob } = await git.readBlob({ fs, dir: root, oid: head, filepath: `f${n}` });
    if (new TextDecoder().decode(blob) !== `next ${n}\n`)
      throw new Error("Checkout corrupted history");
  }
  if (changed === 0 || changed === 32) throw new Error("Expected a partial worktree");
  if ((await run("git checkout base")).exitCode === 0)
    throw new Error("Dirty partial checkout was not guarded");
  await succeed("git checkout --force base");
  for (let n = 0; n < 32; n++)
    if ((await fs.promises.readFile(`${root}/f${n}`, "utf8")) !== `base ${n}\n`)
      throw new Error("Checkout repair failed");
  if ((await run("git status --porcelain")).stdout !== "")
    throw new Error("Checkout repair left dirty files");
  await fs.promises.rm(root, { recursive: true });
  return { iterations: 1, verified: 100 };
}
