import * as git from "isomorphic-git";
import { createFsAdapter } from "../src/fs/index.js";
import { Shell } from "../src/shell/shell.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { benchmarkGitCommand } from "./benchmark-git-command.js";

export const SHELL_GIT_OPERATIONS = [
  "init",
  "populate",
  "add-all",
  "commit",
  "clone-bare",
  "clone-worktree",
  "fetch-unchanged",
  "pull-unchanged",
  "add-unchanged",
  "change-one",
  "add-one",
  "commit-one",
  "push-one",
  "pull-one",
  "change-all",
  "add-changed",
  "remove-files",
  "add-removals-repeat",
  "add-removals",
] as const;
export type ShellGitOperation = (typeof SHELL_GIT_OPERATIONS)[number];
const ROOT = "/scratch/shell-repo";
const REMOTE = "/scratch/shell-remote.git";
const COPY = "/scratch/shell-copy";
const ORIGINAL = "const value = 1;\n".repeat(48);
const CHANGED = "// changed\nconst value = 2;\n";

/** Measure the applet's scoped I/O and command overhead as well as the Git engine. */
export class GitShellBenchmark {
  private readonly shell: Shell;
  constructor(
    private readonly vfs: VirtualFileSystem,
    identityTime?: number,
  ) {
    this.shell = new Shell({
      fileSystem: vfs,
      commands: [benchmarkGitCommand(identityTime)],
      // Permit the baseline's repeated large index writes to finish too.
      // Other limits remain the same as the real shell.
      limits: { maxTotalIoBytes: 128 * 1024 * 1024 },
    });
  }

  private async execute(script: string, cwd = ROOT) {
    const result = await this.shell.executeText({ script, cwd });
    if (result.exitCode !== 0)
      throw new Error(`Shell Git benchmark failed: ${script}: ${result.stderr}`);
  }

  async run(operation: ShellGitOperation, files: number) {
    const fs = createFsAdapter(this.vfs);
    switch (operation) {
      case "init":
        await fs.promises.rm(ROOT, { recursive: true, force: true });
        await fs.promises.mkdir(ROOT, { recursive: true });
        await this.execute(
          "git init -b main; git config user.name Benchmark; git config user.email benchmark@example.invalid",
        );
        break;
      case "populate":
        for (let i = 0; i < files; i++) {
          const sub = `${ROOT}/d${Math.floor(i / 100)}`;
          if (i % 100 === 0) this.vfs.mkdir(sub);
          await this.vfs.writeFile(`${sub}/f${i}.txt`, `file ${i}\n${ORIGINAL}`);
        }
        break;
      case "add-all":
      case "add-unchanged":
      case "add-removals":
      case "add-changed":
        await this.execute("git add -A");
        break;
      case "commit":
        await this.execute("git commit -m initial");
        break;
      case "clone-bare":
        for (const path of [REMOTE, COPY])
          await fs.promises.rm(path, { recursive: true, force: true });
        await this.execute(`git clone --bare . ${REMOTE}; git remote add origin ${REMOTE}`);
        break;
      case "clone-worktree":
        await this.execute(`git clone ${REMOTE} ${COPY}`);
        break;
      case "fetch-unchanged":
        await this.execute("git fetch origin");
        break;
      case "pull-unchanged":
        await this.execute("git pull --ff-only origin main", COPY);
        break;
      case "change-one":
        await this.vfs.writeFile(`${ROOT}/d0/f0.txt`, CHANGED);
        break;
      case "add-one":
        await this.execute("git add d0/f0.txt");
        break;
      case "commit-one":
        await this.execute("git commit -m changed");
        break;
      case "push-one":
        await this.execute("git push origin main");
        break;
      case "pull-one":
        await this.execute("git pull --ff-only origin main", COPY);
        break;
      case "change-all":
        for (let i = 0; i < files; i++)
          await this.vfs.writeFile(
            `${ROOT}/d${Math.floor(i / 100)}/f${i}.txt`,
            `file ${i}\n${ORIGINAL.replaceAll("1", "2")}`,
          );
        break;
      case "add-removals-repeat": {
        const index = `${ROOT}/.git/index`;
        const bytes = await fs.promises.readFile(index);
        try {
          for (let n = 0; n < 20; n++) {
            await this.vfs.writeFile(index, bytes);
            await this.execute("git add -A");
            if ((await git.listFiles({ fs, dir: ROOT })).length !== 0)
              throw new Error("Repeated deletion staging left indexed files");
          }
        } finally {
          // Restore exactly the original index bytes for the normal one-shot
          // deletion row. Reset work is deliberately included in this row.
          await this.vfs.writeFile(index, bytes);
        }
        break;
      }
      case "remove-files":
        for (let i = 0; i < files; i++)
          await this.vfs.remove(`${ROOT}/d${Math.floor(i / 100)}/f${i}.txt`);
        break;
    }
    return {
      iterations:
        operation === "add-removals-repeat"
          ? 20
          : ["populate", "change-all", "remove-files"].includes(operation)
            ? files
            : 1,
      verified: operation === "add-removals-repeat" ? 21 : 1,
    };
  }

  async validate(operation: ShellGitOperation, files: number) {
    const fs = createFsAdapter(this.vfs);
    const options = { fs, dir: ROOT };
    if (operation === "add-changed") {
      let verified = 0;
      await git.walk({
        ...options,
        trees: [git.STAGE()],
        map: async (path, [entry]) => {
          if ((await entry?.type()) !== "blob") return;
          const number = Number(path.match(/f(\d+)\.txt$/u)?.[1]);
          const expected = `file ${number}\n${ORIGINAL.replaceAll("1", "2")}`;
          const blob = await git.readBlob({ ...options, oid: await entry!.oid() });
          if (new TextDecoder().decode(blob.blob) !== expected)
            throw new Error("Changed staging bytes differ");
          verified++;
        },
      });
      if (verified !== files) throw new Error("Changed staging lost files");
      return verified;
    }
    if (operation === "add-one") {
      let oid: string | undefined;
      await git.walk({
        ...options,
        trees: [git.STAGE()],
        map: async (path, [entry]) => {
          if (path === "d0/f0.txt") oid = await entry?.oid();
        },
      });
      if (
        oid === undefined ||
        new TextDecoder().decode((await git.readBlob({ ...options, oid })).blob) !== CHANGED
      )
        throw new Error("Shell Git benchmark did not stage the changed content");
      return 1;
    }
    if (operation !== "add-removals") return 0;
    if ((await git.listFiles(options)).length !== 0)
      throw new Error("Shell Git benchmark did not stage every removal");
    if ((await git.listFiles({ ...options, ref: "HEAD" })).length !== files)
      throw new Error("Shell Git benchmark changed committed history");
    const head = await git.resolveRef({ ...options, ref: "HEAD" });
    if (
      head !== (await git.resolveRef({ fs, dir: COPY, ref: "HEAD" })) ||
      head !== (await git.resolveRef({ fs, dir: REMOTE, gitdir: REMOTE, ref: "HEAD" }))
    )
      throw new Error("Shell Git benchmark local remotes do not match");
    for (let i = 0; i < files; i++) {
      const body = await fs.promises.readFile(`${COPY}/d${Math.floor(i / 100)}/f${i}.txt`, "utf8");
      if (body !== (i === 0 ? CHANGED : `file ${i}\n${ORIGINAL}`))
        throw new Error("Shell Git benchmark local clone/pull changed bytes");
    }
    for (const path of [ROOT, REMOTE, COPY]) await fs.promises.rm(path, { recursive: true });
    return files * 2 + 3;
  }
}
