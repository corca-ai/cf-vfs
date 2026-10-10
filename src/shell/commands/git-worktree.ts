import * as git from "isomorphic-git";
import { VfsError } from "../../core/errors.js";
import { createLineDiff, renderLineDiff } from "../../core/line-diff.js";
import { isDescendant, normalizeFileSystemPath, normalizePath } from "../../core/path.js";
import type { ShellFileDescriptors } from "../types.js";
import { checkoutGit } from "./git-checkout.js";
import { gitArguments, gitOperands } from "./git-options.js";
import { type GitRepository, gitIdentity } from "./git-repository.js";
import { gitMatrix, gitStatusCode, requireCleanGitTree } from "./git-status.js";
import { writeText } from "./helpers.js";

function relativePath(repo: GitRepository, value: string): string {
  const written = normalizeFileSystemPath(value, repo.fs.context.session.cwd);
  let path = normalizePath(written);
  try {
    path = repo.fs.context.fileSystem.realpath(written, { follow: false });
  } catch (error) {
    if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
    const separator = written.lastIndexOf("/");
    const parent = repo.fs.context.fileSystem.realpath(written.slice(0, separator) || "/");
    path = normalizePath(`${parent}/${written.slice(separator + 1)}`);
  }
  if (path !== repo.dir && !isDescendant(repo.dir, path))
    throw new VfsError("EINVAL", "git: path is outside the working tree", value);
  const relative = path === repo.dir ? "." : path.slice(repo.dir === "/" ? 1 : repo.dir.length + 1);
  if (relative === ".git" || relative.startsWith(".git/"))
    throw new VfsError("EINVAL", "git: Git metadata cannot be staged", value);
  return relative;
}

export async function gitAdd(repo: GitRepository, argv: readonly string[]) {
  const args = gitArguments(argv, ["-A", "--all"]);
  gitOperands(args, args.flags.size === 0 ? 1 : 0, Number.MAX_SAFE_INTEGER);
  const paths =
    args.operands.length === 0 ? ["."] : args.operands.map((path) => relativePath(repo, path));
  // Share the index snapshot between inspection and mutation in this command.
  repo.fs.coalesceConfigReads(repo.gitdir);
  const options = { ...repo, cache: {} };
  const sizes = new Map<string, number>();
  const matrix = await gitMatrix(options, paths, sizes);
  const selected = matrix.filter(
    ([path, , work, stage]) =>
      work !== stage &&
      paths.some((prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)),
  );
  // The cache is never reused across shell executions or repository edits.
  // Removing index entries holds no file bodies or compression streams.
  for (const batch of stagingBatches(selected, sizes)) {
    repo.fs.check();
    const bodies = batch.filter(([, , work]) => work !== 0);
    repo.fs.beginObjectWrites(
      repo.gitdir,
      bodies.reduce((sum, [path]) => sum + (sizes.get(path) ?? 0), 0),
      bodies.length,
    );
    try {
      // Matrix already checked ignore rules for new paths; indexed paths are
      // tracked regardless of those rules. Avoid reading every ignore file a
      // second time. HEAD-only paths still need the engine's normal ignore check.
      const existing = batch
        .filter(([, head, work, stage]) => work !== 0 && (head === 0 || stage !== 0))
        .map(([path]) => path);
      if (existing.length > 0) await git.add({ ...options, filepath: existing, force: true });
      const headOnly = batch
        .filter(([, head, work, stage]) => head !== 0 && work !== 0 && stage === 0)
        .map(([path]) => path);
      if (headOnly.length > 0) await git.add({ ...options, filepath: headOnly });
      const removed = batch.filter(([, , work]) => work === 0).map(([path]) => path);
      if (removed.length > 0) await git.remove({ ...options, filepath: removed });
    } finally {
      repo.fs.endObjectWrites();
    }
  }
  for (const path of paths) {
    if (path !== "." && !matrix.some(([name]) => name === path || name.startsWith(`${path}/`)))
      await git.add({ ...options, filepath: path });
  }
}

function* stagingBatches(
  rows: Awaited<ReturnType<typeof gitMatrix>>,
  sizes: ReadonlyMap<string, number>,
) {
  const removalOnly = rows.every(([, , work]) => work === 0);
  for (let start = 0; start < rows.length; ) {
    const end = removalOnly
      ? Math.min(start + 1024, rows.length)
      : smallBatchEnd(rows, sizes, start);
    yield rows.slice(start, end);
    start = end;
  }
}

function smallBatchEnd(
  rows: Awaited<ReturnType<typeof gitMatrix>>,
  sizes: ReadonlyMap<string, number>,
  start: number,
) {
  let end = Math.min(start + 32, rows.length);
  // Large bodies retain the existing 32-file bound. Small-body batches grow
  // to 128 only while their inspected total fits one MiB. Hosts serialize
  // repository edits; this is not a cross-command size cache.
  let bytes = rows.slice(start, end).reduce((total, [path]) => total + (sizes.get(path) ?? 0), 0);
  while (end < rows.length && end - start < 128) {
    const size = sizes.get(rows[end]?.[0] ?? "") ?? 0;
    if (bytes + size > 1024 * 1024) break;
    bytes += size;
    end++;
  }
  return end;
}

export async function gitStatus(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv, ["--short", "-s", "--porcelain"]);
  gitOperands(args, 0);
  const rows = await gitMatrix(repo);
  for (const [path, head, work, stage] of rows) {
    repo.fs.check();
    if (head === work && work === stage) continue;
    const code = gitStatusCode(head, work, stage);
    await writeText(fds[1], `${code} ${JSON.stringify(path)}\n`);
  }
}

export async function gitCommit(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv, ["--allow-empty"], ["-m", "--message"]);
  gitOperands(args, 0);
  const message = args.values.get("-m") ?? args.values.get("--message");
  if (message === undefined) throw new VfsError("EINVAL", "git: commit requires -m MESSAGE");
  const author = await gitIdentity(repo);
  const env = repo.fs.context.session.env;
  const committer = {
    ...author,
    name: env.get("GIT_COMMITTER_NAME") ?? author.name,
    email: env.get("GIT_COMMITTER_EMAIL") ?? author.email,
  };
  const oid = await git.commit({
    ...repo,
    message,
    author,
    committer,
    disallowEmpty: !args.flags.has("--allow-empty"),
  });
  await writeText(fds[1], `${oid}\n`);
}

export async function gitLog(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv, ["--oneline"], ["-n", "--max-count"]);
  gitOperands(args, 0, 1);
  const depth = Number(args.values.get("-n") ?? args.values.get("--max-count") ?? "10");
  if (!Number.isSafeInteger(depth) || depth < 1)
    throw new VfsError("EINVAL", "git: invalid log count");
  for (const { oid, commit } of await git.log({
    ...repo,
    ref: args.operands[0] ?? "HEAD",
    depth,
  })) {
    repo.fs.check();
    const text = args.flags.has("--oneline")
      ? `${oid.slice(0, 7)} ${commit.message.split("\n")[0]}\n`
      : `commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\n\n${commit.message.trimEnd()}\n\n`;
    await writeText(fds[1], text);
  }
}

export async function gitBranch(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv);
  gitOperands(args, 0, 2);
  const name = args.operands[0];
  if (name !== undefined)
    await git.branch({ ...repo, ref: name, object: args.operands[1] ?? "HEAD" });
  else {
    const current = await git.currentBranch(repo);
    for (const branch of await git.listBranches(repo))
      await writeText(fds[1], `${branch === current ? "*" : " "} ${branch}\n`);
  }
}

export async function gitCheckout(repo: GitRepository, argv: readonly string[]) {
  const args = gitArguments(argv, ["--force", "-f"], ["-b"]);
  const force = args.flags.has("--force") || args.flags.has("-f");
  const branch = args.values.get("-b");
  gitOperands(args, branch === undefined ? 1 : 0, 1);
  const ref = branch ?? args.operands[0];
  if (ref === undefined) throw new VfsError("EINVAL", "git: checkout requires a reference");
  if (branch !== undefined)
    await git.branch({ ...repo, ref: branch, object: args.operands[0] ?? "HEAD" });
  const oid = await checkoutOid(repo, ref);
  const head = await git.resolveRef({ ...repo, ref: "HEAD" });
  if (!force && oid === head && branch !== undefined) {
    await git.writeRef({
      ...repo,
      ref: "HEAD",
      value: `refs/heads/${branch}`,
      symbolic: true,
      force: true,
    });
    return;
  }
  if (!force) await requireCleanGitTree(repo);
  await checkoutGit(repo, { ref, force });
}

export async function gitDiff(
  repo: GitRepository,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const args = gitArguments(argv, ["--cached", "--staged"]);
  gitOperands(args, 0);
  const cached = args.flags.size > 0;
  const trees = cached ? [git.TREE({ ref: "HEAD" }), git.STAGE()] : [git.STAGE(), git.WORKDIR()];
  const compare = boundedDiffBodies();
  await git.walk({
    ...repo,
    trees,
    map: async (path, entries) => {
      repo.fs.check();
      if (path === ".git" || path.startsWith(".git/")) return null;
      const [before, after] = entries;
      if (path === "." || (await before?.type()) === "tree" || (await after?.type()) === "tree")
        return;
      if (!cached && before == null) return;
      // Equal object IDs establish byte equality without inflating either blob.
      const oldOid = await before?.oid();
      if (cached && oldOid !== undefined && oldOid === (await after?.oid())) return;
      await compare(() => renderWalkerDiff(repo, fds, path, before, after, cached, oldOid));
      return undefined;
    },
  });
}

function boundedDiffBodies() {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (run: () => Promise<void>) => {
    if (active < 32) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      await run();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active--;
      else next();
    }
  };
}

async function renderWalkerDiff(
  repo: GitRepository,
  fds: ShellFileDescriptors,
  path: string,
  before: git.WalkerEntry | null | undefined,
  after: git.WalkerEntry | null | undefined,
  cached: boolean,
  oldOid: string | undefined,
) {
  repo.fs.check();
  const right = await walkerContent(repo, after, cached);
  // Hash real bytes rather than trusting the engine's whole-second stat cache.
  if (!cached && right !== undefined && oldOid === (await git.hashBlob({ object: right })).oid)
    return;
  const left = await walkerContent(repo, before, true);
  await renderGitDiff(
    repo,
    fds,
    path,
    before == null,
    after == null,
    left ?? new Uint8Array(),
    right ?? new Uint8Array(),
  );
}

async function renderGitDiff(
  repo: GitRepository,
  fds: ShellFileDescriptors,
  path: string,
  added: boolean,
  removed: boolean,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
) {
  if (oldBytes.length === newBytes.length && oldBytes.every((byte, i) => byte === newBytes[i]))
    return;
  const release = repo.fs.context.budget.buffered(oldBytes.byteLength + newBytes.byteLength);
  try {
    const header = `diff --git a/${path} b/${path}\n`;
    if (oldBytes.includes(0) || newBytes.includes(0)) {
      await writeText(fds[1], `${header}Binary files differ\n`);
      return;
    }
    const diff = createLineDiff(
      new TextDecoder().decode(oldBytes),
      new TextDecoder().decode(newBytes),
    );
    await writeText(
      fds[1],
      header +
        renderLineDiff(
          added ? "/dev/null" : `a/${path}`,
          removed ? "/dev/null" : `b/${path}`,
          diff,
        ),
    );
  } finally {
    release();
  }
}

async function walkerContent(
  repo: GitRepository,
  entry: git.WalkerEntry | null | undefined,
  stored: boolean,
) {
  if (entry == null) return undefined;
  if (stored) return (await git.readBlob({ ...repo, oid: await entry.oid() })).blob;
  return await entry.content();
}

async function checkoutOid(repo: GitRepository, ref: string) {
  try {
    return await git.resolveRef({ ...repo, ref });
  } catch (error) {
    if (!(error instanceof git.Errors.NotFoundError)) throw error;
    return await git.resolveRef({ ...repo, ref: `refs/remotes/origin/${ref}` });
  }
}
