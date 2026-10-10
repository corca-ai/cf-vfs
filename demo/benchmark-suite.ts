import git from "isomorphic-git";
import { createLineDiff } from "../src/core/line-diff.js";
import { createFsAdapter } from "../src/fs/index.js";
import { FsMetadataCache } from "../src/fs/metadata.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import {
  RECOVERY_OPERATIONS,
  type RecoveryOperation,
  runGitRecovery,
} from "./benchmark-git-recovery.js";
import {
  GitShellBenchmark,
  SHELL_GIT_OPERATIONS,
  type ShellGitOperation,
} from "./benchmark-git-shell.js";

import {
  GitCodingWorkflow,
  WORKFLOW_OPERATIONS,
  type WorkflowOperation,
} from "./benchmark-git-workflow.js";
import type { BenchmarkRow } from "./benchmark-store.js";

const AUTHOR = {
  name: "cf-vfs benchmark",
  email: "benchmark@example.invalid",
  timestamp: 1700000000,
  timezoneOffset: 0,
};
const BODY = "const value = 1;\n".repeat(48);
const CHANGED = "// changed\nconst value = 2;\n";
export const FILE_OPERATIONS = [
  "write",
  "stat",
  "stat-after-overwrite",
  "read",
  "readdir",
  "append",
  "rename",
  "copy-tree",
  "remove-tree",
] as const;
export const GIT_OPERATIONS = [
  "init",
  "populate",
  "add-all",
  "commit",
  "status-clean",
  "status-change",
  "diff",
  "add-one",
  "commit-one",
  "log",
  "branch",
  "checkout-old",
  "checkout-main",
] as const;
type FileOperation = (typeof FILE_OPERATIONS)[number];
type GitOperation = (typeof GIT_OPERATIONS)[number];
interface BenchmarkWorkload {
  files: number;
  cache: boolean;
  trial: number;
}
export type BenchmarkStage = BenchmarkWorkload &
  (
    | { group: "files"; operation: FileOperation }
    | { group: "git"; operation: GitOperation }
    | { group: "git-shell"; operation: ShellGitOperation }
    | { group: "coding-small" | "coding-mixed"; operation: WorkflowOperation }
    | { group: "git-recovery"; operation: RecoveryOperation }
  );

export function benchmarkPlan(): BenchmarkStage[] {
  const stages: BenchmarkStage[] = [];
  for (const files of [100, 1000]) {
    for (let trial = -1; trial < 3; trial += 1) {
      for (const cache of trial % 2 === 0 ? [false, true] : [true, false]) {
        for (const operation of FILE_OPERATIONS)
          stages.push({ group: "files", operation, files, cache, trial });
        for (const operation of GIT_OPERATIONS)
          stages.push({ group: "git", operation, files, cache, trial });
        // The applet has its own scoped filesystem; adapter metadata caching
        // is not a shell option, so do not label it as a cached variant.
        if (!cache)
          for (const operation of SHELL_GIT_OPERATIONS)
            stages.push({ group: "git-shell", operation, files, cache, trial });
      }
    }
  }
  for (const files of [100, 1000])
    for (let trial = -1; trial < 3; trial++)
      for (const group of ["coding-small", "coding-mixed"] as const)
        for (const operation of WORKFLOW_OPERATIONS)
          stages.push({ group, operation, files, cache: false, trial });
  for (let trial = -1; trial < 3; trial++)
    for (const operation of RECOVERY_OPERATIONS)
      stages.push({ group: "git-recovery", operation, files: 100, cache: false, trial });
  return stages;
}

export function summarizeStage(
  stage: BenchmarkStage,
  samplesMs: number[],
  iterations: number,
): BenchmarkRow {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error("No benchmark samples");
  return {
    group: stage.group,
    operation: stage.operation,
    files: stage.files,
    cache: stage.cache,
    iterations,
    samplesMs,
    medianMs: middle,
    minMs: sorted[0] ?? middle,
    maxMs: sorted.at(-1) ?? middle,
  };
}

function verify(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Benchmark verification failed: ${message}`);
}

/** Only fixed, trusted stages reach this runner; HTTP callers cannot supply paths or sizes. */
export class PublicBenchmarkSuite {
  private readonly gitShell: GitShellBenchmark;
  private readonly codingSmall: GitCodingWorkflow;
  private readonly codingMixed: GitCodingWorkflow;
  private readonly metadata = new FsMetadataCache();
  readonly onEvent = this.metadata.onEvent;

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly identityTime?: number,
  ) {
    this.gitShell = new GitShellBenchmark(vfs, identityTime);
    this.codingSmall = new GitCodingWorkflow(vfs, false, identityTime);
    this.codingMixed = new GitCodingWorkflow(vfs, true, identityTime);
  }

  private adapter(cache: boolean) {
    return createFsAdapter(this.vfs, cache ? { metadataCache: this.metadata } : {});
  }

  async cleanup(): Promise<void> {
    await this.adapter(false).promises.rm("/scratch", { recursive: true, force: true });
  }

  async run(stage: BenchmarkStage): Promise<{ iterations: number; verified: number }> {
    if (stage.group === "files") return this.files(stage);
    if (stage.group === "git-shell") return this.gitShell.run(stage.operation, stage.files);
    if (stage.group === "coding-small") return this.codingSmall.run(stage.operation, stage.files);
    if (stage.group === "coding-mixed") return this.codingMixed.run(stage.operation, stage.files);
    if (stage.group === "git-recovery")
      return runGitRecovery(this.vfs, stage.operation, this.identityTime);
    return this.repository(stage);
  }

  async validate(stage: BenchmarkStage): Promise<number> {
    if (stage.group === "git-shell") return this.gitShell.validate(stage.operation, stage.files);
    if (stage.group === "coding-small")
      return this.codingSmall.validate(stage.operation, stage.files);
    if (stage.group === "coding-mixed")
      return this.codingMixed.validate(stage.operation, stage.files);
    if (stage.group === "git-recovery") return 0;
    const fs = this.adapter(stage.cache).promises;
    if (stage.group === "files") {
      for (let i = 0; i < stage.files; i += 1)
        verify(
          (await fs.readFile(`/scratch/files/renamed${i}`, "utf8")) === `${BODY}suffix`,
          "append/rename preserved bytes",
        );
      await fs.rm("/scratch/files", { recursive: true });
    } else {
      for (let i = 0; i < stage.files; i += 1)
        verify(
          (await fs.readFile(`/scratch/repo/d${Math.floor(i / 100)}/f${i}.txt`, "utf8")) ===
            (i === 0 ? CHANGED : `file ${i}\n${BODY}`),
          "checkout bytes",
        );
      await fs.rm("/scratch/repo", { recursive: true });
    }
    return stage.files;
  }

  private async files(stage: BenchmarkStage): Promise<{ iterations: number; verified: number }> {
    const fs = this.adapter(stage.cache).promises;
    const root = "/scratch/files";
    const iterations = stage.files;
    switch (stage.operation) {
      case "write":
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm("/scratch/copied", { recursive: true, force: true });
        await fs.mkdir(root, { recursive: true });
        for (let i = 0; i < iterations; i += 1) await fs.writeFile(`${root}/f${i}`, BODY);
        break;
      case "stat":
        await fs.readdir(root);
        for (let i = 0; i < iterations; i += 1)
          verify((await fs.stat(`${root}/f${i}`)).size === BODY.length, "stat size");
        break;
      case "stat-after-overwrite":
        await fs.writeFile(`${root}/f0`, BODY);
        for (let i = 0; i < iterations; i += 1)
          verify((await fs.stat(`${root}/f${i}`)).size === BODY.length, "metadata after overwrite");
        break;
      case "read":
        for (let i = 0; i < iterations; i += 1)
          verify((await fs.readFile(`${root}/f${i}`, "utf8")) === BODY, "read bytes");
        break;
      case "readdir":
        for (let i = 0; i < 10; i += 1)
          verify((await fs.readdir(root)).length === iterations, "directory count");
        return { iterations: 10, verified: 10 };
      case "append":
        for (let i = 0; i < iterations; i += 1)
          await fs.writeFile(`${root}/f${i}`, "suffix", { flag: "a" });
        break;
      case "rename":
        for (let i = 0; i < iterations; i += 1)
          await fs.rename(`${root}/f${i}`, `${root}/renamed${i}`);
        break;
      case "copy-tree":
        await this.vfs.copy(root, "/scratch/copied", { recursive: true });
        verify(this.vfs.list("/scratch/copied").length === iterations, "copied count");
        break;
      case "remove-tree":
        await fs.rm("/scratch/copied", { recursive: true });
        break;
      default:
        throw new Error("Unknown file stage");
    }
    return {
      iterations: ["copy-tree", "remove-tree"].includes(stage.operation) ? 1 : iterations,
      verified: 1,
    };
  }

  private async repository(
    stage: BenchmarkStage,
  ): Promise<{ iterations: number; verified: number }> {
    const fs = this.adapter(stage.cache);
    const dir = "/scratch/repo";
    const opts = { fs, dir };
    const target = `${dir}/d0/f0.txt`;
    switch (stage.operation) {
      case "init":
        await fs.promises.rm(dir, { recursive: true, force: true });
        await fs.promises.mkdir(dir, { recursive: true });
        await git.init({ ...opts, defaultBranch: "main" });
        break;
      case "populate":
        for (let i = 0; i < stage.files; i += 1) {
          const sub = `d${Math.floor(i / 100)}`;
          if (i % 100 === 0) await fs.promises.mkdir(`${dir}/${sub}`);
          await fs.promises.writeFile(`${dir}/${sub}/f${i}.txt`, `file ${i}\n${BODY}`);
        }
        break;
      case "add-all":
        // Each file opens a zlib compressor in the Node-compatible Git build.
        // Bound that concurrency to fit a production isolate, using Git's
        // existing filepath-array API. The timer covers the complete add.
        for (let offset = 0; offset < stage.files; offset += 32) {
          const filepath = Array.from(
            { length: Math.min(32, stage.files - offset) },
            (_, index) => {
              const file = offset + index;
              return `d${Math.floor(file / 100)}/f${file}.txt`;
            },
          );
          await git.add({ ...opts, filepath });
        }
        break;
      case "commit": {
        const oid = await git.commit({ ...opts, message: "initial", author: AUTHOR });
        await git.writeRef({ ...opts, ref: "refs/heads/benchmark-initial", value: oid });
        break;
      }
      case "status-clean": {
        const matrix = await git.statusMatrix(opts);
        verify(
          matrix.length === stage.files &&
            matrix.every((row) => row[1] === 1 && row[2] === 1 && row[3] === 1),
          "clean status",
        );
        break;
      }
      case "status-change": {
        await fs.promises.writeFile(target, CHANGED);
        const matrix = await git.statusMatrix(opts);
        verify(matrix.filter((row) => row[1] !== row[2]).length === 1, "one changed file");
        break;
      }
      case "diff": {
        const original = await git.readBlob({
          ...opts,
          oid: await git.resolveRef({ ...opts, ref: "benchmark-initial" }),
          filepath: "d0/f0.txt",
        });
        const next = await fs.promises.readFile(target, "utf8");
        verify(createLineDiff(new TextDecoder().decode(original.blob), next).changes > 0, "diff");
        break;
      }
      case "add-one":
        await git.add({ ...opts, filepath: "d0/f0.txt" });
        break;
      case "commit-one":
        await git.commit({ ...opts, message: "changed", author: AUTHOR });
        break;
      case "log": {
        const commits = await git.log({ ...opts, depth: 2 });
        verify(
          commits.length === 2 &&
            commits[1]?.oid === (await git.resolveRef({ ...opts, ref: "benchmark-initial" })),
          "commit chain",
        );
        break;
      }
      case "branch":
        await git.branch({ ...opts, ref: "feature" });
        break;
      case "checkout-old":
        await git.checkout({ ...opts, ref: "benchmark-initial" });
        verify((await fs.promises.readFile(target, "utf8")) === `file 0\n${BODY}`, "old checkout");
        break;
      case "checkout-main":
        await git.checkout({ ...opts, ref: "main" });
        verify((await fs.promises.readFile(target, "utf8")) === CHANGED, "main checkout");
        break;
      default:
        throw new Error("Unknown Git stage");
    }
    return { iterations: stage.operation === "populate" ? stage.files : 1, verified: 1 };
  }
}
