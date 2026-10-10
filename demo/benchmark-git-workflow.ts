import * as git from "isomorphic-git";
import { createFsAdapter } from "../src/fs/index.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";

export const WORKFLOW_OPERATIONS = [
  "prepare",
  "clone",
  "status-clean",
  "edit",
  "status-dirty",
  "diff",
  "add-partial",
  "diff-staged",
  "commit-partial",
  "add-rest",
  "commit-rest",
  "checkout-base",
  "checkout-main",
  "status-final",
] as const;
export type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];
const SOURCE = "/scratch/coding-source";
const COPY = "/scratch/coding-copy";
const EDITED = "export const edited = true;\n";

export function workflowBody(index: number, mixed: boolean): Uint8Array {
  const length = mixed && index < 4 ? 256 * 1024 : 768;
  let seed = index + 1;
  return Uint8Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return 32 + ((seed >>> 24) % 95);
  });
}

/** Connected coding session; mixed data includes four poorly compressible 256 KiB files. */
export class GitCodingWorkflow {
  private readonly shell: Shell;
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly mixed: boolean,
  ) {
    this.shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  }
  private async execute(script: string, cwd = COPY) {
    const result = await this.shell.executeText({ script, cwd });
    if (result.exitCode !== 0) throw new Error(`${script}: ${result.stderr}`);
    return result.stdout;
  }
  async run(operation: WorkflowOperation, files: number) {
    switch (operation) {
      case "prepare":
        for (const path of [SOURCE, COPY])
          await createFsAdapter(this.vfs).promises.rm(path, { recursive: true, force: true });
        await this.execute(`git init ${SOURCE}`, "/");
        await this.execute(
          "git config user.name Coding; git config user.email coding@example.invalid",
          SOURCE,
        );
        for (let n = 0; n < files; n++)
          await this.vfs.writeFile(`${SOURCE}/f${n}`, workflowBody(n, this.mixed));
        await this.execute("git add -A && git commit -m base && git branch base", SOURCE);
        break;
      case "clone":
        await this.execute(`git clone ${SOURCE} ${COPY}`, "/");
        await this.execute(
          "git config user.name Coding; git config user.email coding@example.invalid",
        );
        break;
      case "status-clean":
      case "status-final":
        if ((await this.execute("git status --porcelain")) !== "")
          throw new Error("Expected clean worktree");
        break;
      case "edit":
        await this.vfs.writeFile(`${COPY}/f0`, EDITED);
        await this.vfs.remove(`${COPY}/f1`);
        await this.vfs.writeFile(`${COPY}/added`, "new file\n");
        break;
      case "status-dirty": {
        const status = await this.execute("git status --porcelain");
        if (status.trim().split("\n").length !== 3) throw new Error("Expected three changes");
        break;
      }
      case "diff":
        if (!(await this.execute("git diff")).includes("diff --git"))
          throw new Error("Missing worktree diff");
        break;
      case "add-partial":
        await this.execute("git add f0 added");
        break;
      case "diff-staged":
        if (!(await this.execute("git diff --cached")).includes("added"))
          throw new Error("Missing staged addition");
        break;
      case "commit-partial":
        await this.execute("git commit -m partial");
        break;
      case "add-rest":
        await this.execute("git add -A");
        break;
      case "commit-rest":
        await this.execute("git commit -m deletion");
        break;
      case "checkout-base":
        await this.execute("git checkout base");
        break;
      case "checkout-main":
        await this.execute("git checkout main");
        break;
    }
    return { iterations: 1, verified: 1 };
  }
  async validate(operation: WorkflowOperation, files: number): Promise<number> {
    const fs = createFsAdapter(this.vfs);
    const opts = { fs, dir: COPY };
    if (operation === "commit-partial") {
      const head = await git.resolveRef({ ...opts, ref: "HEAD" });
      const old = await git.readBlob({ ...opts, oid: head, filepath: "f1" });
      if (old.blob.length !== workflowBody(1, this.mixed).length)
        throw new Error("Unstaged deletion committed");
      const status = await this.execute("git status --porcelain");
      if (!status.includes(' D "f1"') || status.trim().split("\n").length !== 1)
        throw new Error("Partial commit changed selection");
      return 2;
    }
    const original = operation === "clone" || operation === "checkout-base";
    if (!original && operation !== "checkout-main") return 0;
    const expectedFiles = Array.from({ length: files }, (_, n) => `f${n}`).filter(
      (name) => original || name !== "f1",
    );
    if (!original) expectedFiles.push("added");
    const actual = await git.listFiles(opts);
    if (actual.slice().sort().join("\n") !== expectedFiles.sort().join("\n"))
      throw new Error("Index paths differ");
    for (const path of expectedFiles) {
      const expected =
        path === "added"
          ? new TextEncoder().encode("new file\n")
          : !original && path === "f0"
            ? new TextEncoder().encode(EDITED)
            : workflowBody(Number(path.slice(1)), this.mixed);
      const bytes = await fs.promises.readFile(`${COPY}/${path}`);
      if (bytes.length !== expected.length || !bytes.every((byte, n) => byte === expected[n]))
        throw new Error(`Checkout bytes differ: ${path}`);
    }
    if (operation === "checkout-main") {
      if ((await git.log({ ...opts })).length !== 3) throw new Error("Commit history differs");
    }
    return files + 1;
  }
}
