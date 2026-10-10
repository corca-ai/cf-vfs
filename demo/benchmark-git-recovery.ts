import * as git from "isomorphic-git";
import { VfsError } from "../src/core/errors.js";
import { createFsAdapter } from "../src/fs/index.js";
import { Shell } from "../src/shell/shell.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { runCheckoutRecovery } from "./benchmark-git-checkout-recovery.js";
import { benchmarkGitCommand } from "./benchmark-git-command.js";
import { WorkspaceOperations } from "./workspace-operations.js";

export const RECOVERY_OPERATIONS = [
  "batch-capacity",
  "batch-missing-parent",
  "index-capacity",
  "cancel-mid-add",
  "serialized-two-shells",
  "concurrent-two-adds",
  "partial-add-retry",
  "checkout-failure",
] as const;
export type RecoveryOperation = (typeof RECOVERY_OPERATIONS)[number];
const ROOT = "/scratch/recovery";

/** Faults are local to this isolated benchmark VFS, never to the public shell. */
export async function runGitRecovery(
  vfs: VirtualFileSystem,
  operation: RecoveryOperation,
  identityTime?: number,
) {
  if (operation === "checkout-failure") return runCheckoutRecovery(vfs, identityTime);
  const fs = createFsAdapter(vfs);
  await fs.promises.rm(ROOT, { recursive: true, force: true });
  const shell = new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] });
  const run = (script: string) => shell.executeText({ script, cwd: ROOT });
  const requireSuccess = async (script: string) => {
    const outcome = await run(script);
    if (outcome.exitCode !== 0) throw new Error(`${script}: ${outcome.stderr}`);
  };
  await shell.executeText({ script: `git init ${ROOT}` });
  await requireSuccess(
    "git config user.name Recovery; git config user.email recovery@example.invalid",
  );
  await vfs.writeFile(`${ROOT}/seed`, "seed\n");
  await requireSuccess("git add seed && git commit -m seed");
  const oldIndex = await fs.promises.readFile(`${ROOT}/.git/index`);
  const head = await git.resolveRef({ fs, dir: ROOT, ref: "HEAD" });
  const files = operation === "partial-add-retry" ? 256 : 32;
  for (let n = 0; n < files; n++) await vfs.writeFile(`${ROOT}/new${n}`, `new body ${n}\n`);
  if (operation === "concurrent-two-adds") {
    const callers = [
      new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] }),
      new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] }),
    ];
    const outcomes = await Promise.all(
      callers.map((caller, n) => caller.executeText({ script: `git add new${n}`, cwd: ROOT })),
    );
    if (outcomes.some((outcome) => outcome.exitCode !== 0))
      throw new Error("Concurrent adds failed");
    const staged = await git.listFiles({ fs, dir: ROOT });
    if (staged.length !== 3 || !staged.includes("new0") || !staged.includes("new1"))
      throw new Error("Concurrent adds lost selection");
    await requireSuccess("git add -A");
  } else if (operation === "serialized-two-shells") {
    const other = new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] });
    // Host serialization is the documented contract, including edits. Two callers
    // submit concurrently, but the per-repository host queue owns execution.
    const operations = new WorkspaceOperations();
    const enqueue = (target: Shell, script: string) =>
      operations.run(() => target.executeText({ script, cwd: ROOT }));
    const outcomes = await Promise.all([
      enqueue(shell, "git add seed"),
      enqueue(other, "git add -A"),
    ]);
    if (outcomes.some((outcome) => outcome.exitCode !== 0))
      throw new Error("Serialized callers failed");
  } else {
    let injected = false;
    let batches = 0;
    const controller = new AbortController();
    const wrapped = new Proxy(vfs, {
      get(target, property) {
        // Keep fault injection on the exact capability passed to the shell.
        if (property === "forCredentials") return undefined;
        if (property === "writeFiles")
          return async (...args: Parameters<VirtualFileSystem["writeFiles"]>) => {
            batches++;
            if (
              !injected &&
              (operation.startsWith("batch-") ||
                (operation === "partial-add-retry" && batches === 2))
            ) {
              injected = true;
              throw new VfsError(
                operation === "batch-capacity" ? "ENOSPC" : "ENOENT",
                "injected batch failure",
              );
            }
            return target.writeFiles(...args);
          };
        if (property === "writeFile")
          return async (...args: Parameters<VirtualFileSystem["writeFile"]>) => {
            if (!injected && operation === "index-capacity" && args[0] === `${ROOT}/.git/index`) {
              injected = true;
              throw new VfsError("ENOSPC", "injected index capacity exhaustion");
            }
            return target.writeFile(...args);
          };
        if (property === "readFile")
          return (...args: Parameters<VirtualFileSystem["readFile"]>) => {
            const result = target.readFile(...args);
            if (!injected && operation === "cancel-mid-add" && args[0] === `${ROOT}/new0`) {
              injected = true;
              controller.abort();
            }
            return result;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const faulty = new Shell({
      fileSystem: wrapped,
      commands: [benchmarkGitCommand(identityTime)],
    });
    const failed = await faulty.executeText({
      script: "git add -A",
      cwd: ROOT,
      signal: controller.signal,
    });
    if (!injected || failed.exitCode === 0) throw new Error(`Fault was not observed: ${operation}`);
    const after = await fs.promises.readFile(`${ROOT}/.git/index`);
    if (operation === "partial-add-retry") {
      const staged = await git.listFiles({ fs, dir: ROOT });
      if (staged.length !== 129)
        throw new Error(`Expected first batch to persist, got ${staged.length}`);
      await git.walk({
        fs,
        dir: ROOT,
        trees: [git.STAGE()],
        map: async (_path, [entry]) => {
          if (entry != null && (await entry.type()) === "blob")
            await git.readBlob({ fs, dir: ROOT, oid: await entry.oid() });
        },
      });
    } else if (after.length !== oldIndex.length || !after.every((byte, n) => byte === oldIndex[n]))
      throw new Error("Failed add published an index");
    if ((await git.resolveRef({ fs, dir: ROOT, ref: "HEAD" })) !== head)
      throw new Error("Failed add changed HEAD");
    await requireSuccess("git add -A");
  }
  await requireSuccess("git commit -m recovered");
  if ((await run("git status --porcelain")).stdout !== "")
    throw new Error("Recovery left a dirty tree");
  const oid = await git.resolveRef({ fs, dir: ROOT, ref: "HEAD" });
  for (let n = 0; n < files; n++) {
    const { blob } = await git.readBlob({ fs, dir: ROOT, oid, filepath: `new${n}` });
    if (new TextDecoder().decode(blob) !== `new body ${n}\n`)
      throw new Error("Recovered blob differs");
  }
  await fs.promises.rm(ROOT, { recursive: true });
  return { iterations: 1, verified: files + 4 };
}
