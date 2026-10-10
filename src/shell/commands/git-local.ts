import * as git from "isomorphic-git";
import { VfsError } from "../../core/errors.js";
import { basename, dirname, isDescendant, normalizePath } from "../../core/path.js";
import type { ShellFileDescriptors } from "../types.js";
import { checkoutGit } from "./git-checkout.js";
import type { GitFileSystem } from "./git-fs.js";
import { copyFreshGitObjects, GitObjectTree } from "./git-object-copy.js";
import { gitArguments, gitOperands, localGitPath } from "./git-options.js";
import { type GitRepository, gitExists, gitHead, gitRepository } from "./git-repository.js";
import { requireCleanGitTree } from "./git-status.js";
import { writeText } from "./helpers.js";

async function copyObjects(
  source: GitRepository,
  target: GitRepository,
  fresh = false,
): Promise<void> {
  if (
    gitExists(source.fs, `${source.gitdir}/shallow`) ||
    gitExists(source.fs, `${source.gitdir}/objects/info/alternates`)
  )
    throw new VfsError(
      "ENOTSUP",
      "git: shallow repositories and object alternates are unsupported",
    );
  const tree = new GitObjectTree(source.fs);
  const from = `${source.gitdir}/objects`,
    to = `${target.gitdir}/objects`;
  if (fresh && (await copyFreshGitObjects(source.fs, from, to, tree))) return;
  await copyDirectory(source.fs, from, to, tree);
}

async function copyDirectory(
  fs: GitFileSystem,
  source: string,
  target: string,
  tree: GitObjectTree,
): Promise<void> {
  fs.check();
  fs.mkdir(target, true);
  for (const entry of tree.consume(source)) {
    fs.check();
    const from = `${source}/${entry.name}`,
      to = `${target}/${entry.name}`;
    if (entry.kind === "symlink")
      throw new VfsError("ENOTSUP", "git: symbolic links in object storage are unsupported", from);
    if (entry.kind === "directory") await copyDirectory(fs, from, to, tree);
    else if (!gitExists(fs, to)) {
      const bytes = await fs.promises.readFile(from);
      if (typeof bytes === "string") throw new VfsError("EIO", "expected binary Git object", from);
      await fs.promises.writeFile(to, bytes);
    }
  }
}

async function importRefs(
  source: GitRepository,
  target: GitRepository,
  remote: string,
  bare = false,
  fresh = false,
) {
  await copyObjects(source, target, fresh);
  const branches = await git.listBranches(source);
  for (const branch of branches) {
    source.fs.check();
    const oid = await git.resolveRef({ ...source, ref: `refs/heads/${branch}` });
    await git.writeRef({
      ...target,
      ref: bare ? `refs/heads/${branch}` : `refs/remotes/${remote}/${branch}`,
      value: oid,
      force: true,
    });
  }
  for (const tag of await git.listTags(source)) {
    const ref = `refs/tags/${tag}`;
    const oid = await git.resolveRef({ ...source, ref });
    if (gitExists(target.fs, `${target.gitdir}/${ref}`)) {
      if ((await git.resolveRef({ ...target, ref })) !== oid)
        throw new VfsError("EEXIST", "git: refusing to replace an existing tag", tag);
    } else await git.writeRef({ ...target, ref, value: oid });
  }
  return branches;
}

export async function localClone(
  fs: GitFileSystem,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv, ["--bare", "--no-checkout"], ["-b", "--branch"]);
  gitOperands(args, 1, 2);
  const path = localGitPath(args.operands[0] ?? "", fs.context.session.cwd);
  const source = gitRepository(fs, path, false);
  const requestedBranch = args.values.get("-b") ?? args.values.get("--branch");
  const available = await git.listBranches(source);
  if (requestedBranch !== undefined && !available.includes(requestedBranch))
    throw new VfsError("ENOENT", "git: requested branch not found", requestedBranch);
  const name = basename(path).replace(/\.git$/u, "");
  const destination = localGitPath(args.operands[1] ?? name, fs.context.session.cwd);
  const bare = args.flags.has("--bare");
  if (gitExists(fs, destination) && fs.context.fileSystem.list(destination).length !== 0)
    throw new VfsError("EEXIST", "git: clone destination is not empty", destination);
  fs.mkdir(destination, true);
  const dir = fs.context.fileSystem.realpath(destination);
  if (dir === source.dir || dir === source.gitdir || isDescendant(source.gitdir, dir))
    throw new VfsError("EINVAL", "git: destination overlaps source object storage");
  const target = { fs, dir, gitdir: bare ? dir : normalizePath(`${dir}/.git`) };
  const current = await git.currentBranch(source);
  const selectedBranch = requestedBranch ?? (typeof current === "string" ? current : undefined);
  const branch = selectedBranch ?? "main";
  await git.init({ ...target, bare, defaultBranch: branch });
  await git.setConfig({ ...target, path: "remote.origin.url", value: source.dir });
  await git.setConfig({
    ...target,
    path: "remote.origin.fetch",
    value: "+refs/heads/*:refs/remotes/origin/*",
  });
  const branches = await importRefs(source, target, "origin", bare, true);
  await checkoutClone(
    source,
    target,
    selectedBranch,
    branches,
    bare,
    args.flags.has("--no-checkout"),
  );
  await writeText(fds[2], `Cloned local repository into '${dir}'.\n`);
}

async function remoteRepository(repo: GitRepository, remote: string) {
  const url: unknown = await git.getConfig({ ...repo, path: `remote.${remote}.url` });
  if (typeof url !== "string")
    throw new VfsError("ENOENT", "git: remote is not configured", remote);
  return gitRepository(repo.fs, localGitPath(url, repo.dir), false);
}

export async function localFetch(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv);
  gitOperands(args, 0, 1);
  const remote = args.operands[0] ?? "origin";
  const source = await remoteRepository(repo, remote);
  await importRefs(source, repo, remote);
  const branch = await git.currentBranch(source);
  if (
    branch !== undefined &&
    (await git.listBranches(source).then((names) => names.includes(branch)))
  )
    await git.writeRef({
      ...repo,
      ref: `refs/remotes/${remote}/HEAD`,
      value: `refs/remotes/${remote}/${branch}`,
      symbolic: true,
      force: true,
    });
  await writeText(fds[2], `Fetched local remote '${remote}'.\n`);
}

async function setTracking(
  repo: GitRepository,
  branch: string,
  remote: string,
  remoteBranch: string,
) {
  await git.setConfig({ ...repo, path: `branch.${branch}.remote`, value: remote });
  await git.setConfig({
    ...repo,
    path: `branch.${branch}.merge`,
    value: `refs/heads/${remoteBranch}`,
  });
}

export async function localPush(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv, ["-u", "--set-upstream"]);
  gitOperands(args, 0, 2);
  const remote = args.operands[0] ?? "origin";
  const target = await remoteRepository(repo, remote);
  const current = await git.currentBranch(repo);
  const refspec = args.operands[1] ?? current;
  if (refspec === undefined) throw new VfsError("EINVAL", "git: push requires a branch");
  const [from, to = from, extra] = refspec.split(":");
  if (!from || !to || extra !== undefined || from.startsWith("+") || to.startsWith("refs/"))
    throw new VfsError(
      "ENOTSUP",
      "git: only branch pushes without force or deletion are supported",
    );
  // Validate the destination before deriving a pathname for guarded publication.
  if (
    !/^[A-Za-z0-9_-]+(?:[/.][A-Za-z0-9_-]+)*$/u.test(to) ||
    to === "HEAD" ||
    to.split("/").some((part) => part.endsWith(".lock"))
  )
    throw new VfsError("EINVAL", "git: unsupported destination branch name", to);
  const bare: unknown = await git.getConfig({ ...target, path: "core.bare" });
  if (bare !== true && bare !== "true" && (await git.currentBranch(target)) === to)
    throw new VfsError("EACCES", "git: refusing to push to the checked-out branch", to);
  const ref = `refs/heads/${to}`,
    refPath = normalizePath(`${target.gitdir}/${ref}`);
  target.fs.mkdir(dirname(refPath), true);
  const token = target.fs.context.fileSystem.getMutationToken(refPath);
  const old = await optionalRef(target, ref);
  const oid = await git.resolveRef({ ...repo, ref: from });
  await copyObjects(repo, target);
  if (
    old !== undefined &&
    old !== oid &&
    !(await git.isDescendent({ ...target, oid, ancestor: old }))
  )
    throw new VfsError("EEXIST", "git: non-fast-forward push rejected", to);
  target.fs.check();
  target.fs.context.budget.io(41);
  await target.fs.context.fileSystem.writeFile(refPath, `${oid}\n`, { ifMutationToken: token });
  await git.writeRef({ ...repo, ref: `refs/remotes/${remote}/${to}`, value: oid, force: true });
  if (args.flags.size > 0) await setTracking(repo, from, remote, to);
  await writeText(fds[2], `Pushed '${from}' to local remote '${remote}/${to}'.\n`);
}

async function optionalRef(repo: GitRepository, ref: string): Promise<string | undefined> {
  try {
    return await git.resolveRef({ ...repo, ref });
  } catch (error) {
    if (error instanceof git.Errors.NotFoundError) return undefined;
    throw error;
  }
}

export async function localPull(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv, ["--ff-only"]);
  gitOperands(args, 0, 2);
  const branch = await git.currentBranch(repo);
  if (branch === undefined) throw new VfsError("EINVAL", "git: pull requires a checked-out branch");
  const configuredRemote: unknown = await git.getConfig({
    ...repo,
    path: `branch.${branch}.remote`,
  });
  const remote =
    args.operands[0] ?? (typeof configuredRemote === "string" ? configuredRemote : "origin");
  const merge: unknown = await git.getConfig({ ...repo, path: `branch.${branch}.merge` });
  const remoteBranch =
    args.operands[1] ?? (typeof merge === "string" ? merge.replace(/^refs\/heads\//u, "") : branch);
  await localFetch(repo, [remote], fds);
  const theirs = `refs/remotes/${remote}/${remoteBranch}`;
  await requireCleanGitTree(repo);
  const ours = await gitHead(repo);
  // An unchanged remote requires no checkout or reference publication.
  if (ours === undefined || ours !== (await optionalRef(repo, theirs))) {
    await checkoutGit(repo, { ref: theirs, dryRun: true });
    await git.merge({ ...repo, ours: branch, theirs, fastForwardOnly: true });
    await checkoutGit(repo, { ref: branch });
  }
  await writeText(fds[2], "Updated by fast-forward only.\n");
}

async function checkoutClone(
  source: GitRepository,
  target: GitRepository,
  branch: string | undefined,
  branches: string[],
  bare: boolean,
  noCheckout: boolean,
) {
  if (branch !== undefined && branches.includes(branch)) {
    const oid = await git.resolveRef({ ...source, ref: `refs/heads/${branch}` });
    await git.writeRef({ ...target, ref: `refs/heads/${branch}`, value: oid, force: true });
    await setTracking(target, branch, "origin", branch);
    if (!bare && !noCheckout) await checkoutGit(target, { ref: branch });
  } else {
    const oid = await gitHead(source);
    if (oid !== undefined) {
      await git.writeRef({ ...target, ref: "HEAD", value: oid, force: true });
      if (!bare && !noCheckout) await checkoutGit(target, { ref: oid });
    }
  }
}
