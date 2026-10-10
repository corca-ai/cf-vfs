import * as git from "isomorphic-git";
import { VfsError } from "../../core/errors.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { defineApplet } from "./applet.js";
import { GitFileSystem } from "./git-fs.js";
import { localClone, localFetch, localPull, localPush } from "./git-local.js";
import { gitArguments, gitOperands, localGitPath } from "./git-options.js";
import { type GitRepository, gitRepository } from "./git-repository.js";
import {
  gitAdd,
  gitBranch,
  gitCheckout,
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
} from "./git-worktree.js";
import { commandPath, writeText } from "./helpers.js";

const SPEC = {
  name: "git",
  usage: "[-C DIRECTORY] COMMAND [ARGUMENT...]",
  summary: "operates Git repositories and local remotes in the VFS",
} as const;

export const gitCommand = /* @__PURE__ */ defineApplet(SPEC, async (context, argv, fds) => {
  try {
    return await executeGit(context, argv, fds);
  } catch (error) {
    if (error instanceof VfsError) throw error;
    await writeText(fds[2], `git: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
});

async function executeGit(
  context: ShellCommandContext,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  let index = 0,
    cwd = context.session.cwd;
  while (argv[index] === "-C") {
    const path = argv[index + 1];
    if (path === undefined) throw new VfsError("EINVAL", "git: -C requires a directory");
    cwd = localGitPath(path, cwd);
    if (context.fileSystem.stat(cwd).kind !== "directory")
      throw new VfsError("ENOTDIR", "git: not a directory", cwd);
    index += 2;
  }
  const scoped = { ...context, session: { ...context.session, cwd } };
  const fs = new GitFileSystem(scoped);
  const command = argv[index],
    args = argv.slice(index + 1);
  if (command === undefined || command === "--help") {
    await writeText(
      fds[1],
      "git: init add status diff commit log branch checkout config remote clone fetch push pull rev-parse\nLocal paths only; pull is fast-forward only.\n",
    );
    return 0;
  }
  if (command === "init") await initialize(fs, args);
  else if (command === "clone") await localClone(fs, args, fds);
  else await repositoryCommand(gitRepository(fs, cwd), command, args, fds);
  fs.check();
  return 0;
}

async function initialize(fs: GitFileSystem, argv: readonly string[]) {
  const args = gitArguments(argv, ["--bare"], ["-b", "--initial-branch"]);
  gitOperands(args, 0, 1);
  const dir = commandPath(fs.context, args.operands[0] ?? ".");
  await git.init({
    fs,
    dir,
    bare: args.flags.has("--bare"),
    defaultBranch: args.values.get("-b") ?? args.values.get("--initial-branch") ?? "main",
  });
}

async function repositoryCommand(
  repo: GitRepository,
  command: string,
  args: readonly string[],
  fds: ShellFileDescriptors,
) {
  if (
    repo.gitdir === repo.dir &&
    ["add", "status", "diff", "commit", "checkout", "pull"].includes(command)
  )
    throw new VfsError("ENOTSUP", "git: command requires a working tree");
  switch (command) {
    case "add":
      return gitAdd(repo, args);
    case "status":
      return gitStatus(repo, args, fds);
    case "diff":
      return gitDiff(repo, args, fds);
    case "commit":
      return gitCommit(repo, args, fds);
    case "log":
      return gitLog(repo, args, fds);
    case "branch":
      return gitBranch(repo, args, fds);
    case "checkout":
      return gitCheckout(repo, args);
    case "fetch":
      return localFetch(repo, args, fds);
    case "push":
      return localPush(repo, args, fds);
    case "pull":
      return localPull(repo, args, fds);
    case "config":
      return configure(repo, args, fds);
    case "remote":
      return remote(repo, args, fds);
    case "rev-parse": {
      const parsed = gitArguments(args);
      gitOperands(parsed, 1);
      await writeText(
        fds[1],
        `${await git.resolveRef({ ...repo, ref: parsed.operands[0] ?? "HEAD" })}\n`,
      );
      return;
    }
    default:
      throw new VfsError("ENOTSUP", `git: unsupported command ${command}`);
  }
}

async function configure(repo: GitRepository, argv: readonly string[], fds: ShellFileDescriptors) {
  const args = gitArguments(argv, ["--local", "--get"]);
  gitOperands(args, 1, 2);
  const path = args.operands[0] ?? "";
  if (args.flags.has("--get") && args.operands.length !== 1)
    throw new VfsError("EINVAL", "git: --get takes one key");
  const value = args.operands[1];
  if (value === undefined) {
    const found: unknown = await git.getConfig({ ...repo, path });
    if (found === undefined) throw new VfsError("ENOENT", "git: config key not found", path);
    await writeText(fds[1], `${String(found)}\n`);
  } else await git.setConfig({ ...repo, path, value });
}

async function remote(repo: GitRepository, argv: readonly string[], fds: ShellFileDescriptors) {
  if (argv[0] === "add") {
    const args = gitArguments(argv.slice(1));
    gitOperands(args, 2);
    const name = args.operands[0] ?? "",
      value = args.operands[1] ?? "";
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new VfsError("EINVAL", "git: invalid remote name");
    await git.addRemote({
      ...repo,
      remote: name,
      url: localGitPath(value, repo.fs.context.session.cwd),
    });
  } else {
    const args = gitArguments(argv, ["-v"]);
    gitOperands(args, 0);
    for (const entry of await git.listRemotes(repo))
      await writeText(
        fds[1],
        args.flags.has("-v") ? `${entry.remote}\t${entry.url}\n` : `${entry.remote}\n`,
      );
  }
}
