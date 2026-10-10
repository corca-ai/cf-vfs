import { readFile, writeFile } from "node:fs/promises";

// Reconstruct only the two edited optional-applet functions from the deployed
// baseline. All filesystem/runtime code and installed dependencies stay equal.
const root = process.argv[2];
const statusPath = `${root}/src/shell/commands/git-status.ts`;
const status = await readFile(statusPath, "utf8");
await writeFile(
  statusPath,
  status.replace(
    /export async function gitMatrix[\s\S]*?(?=async function entryIdentity)/,
    `export async function gitMatrix(repo: GitRepository) {
  const rows: Array<[string, number, number, number]> = [];
  await git.walk({
    ...repo,
    trees: [git.TREE({ ref: "HEAD" }), git.WORKDIR(), git.STAGE()],
    map: async (path, entries) => {
      repo.fs.check();
      if (path === ".git" || path.startsWith(".git/")) return null;
      const [head, work, stage] = entries;
      const types = await Promise.all(entries.map((entry) => entry?.type()));
      if (path === "." || types.includes("tree")) return;
      if (head === null && stage === null && (await git.isIgnored({ ...repo, filepath: path }))) return;
      const h = await entryIdentity(head), i = await entryIdentity(stage);
      const w = await workIdentity(work);
      rows.push([path, h === undefined ? 0 : 1, matrixColumn(h, w), matrixColumn(h, i, w)]);
      return undefined;
    },
  });
  return rows.sort((a, b) => compareUtf8(a[0], b[0]));
}

`,
  ),
);
const worktreePath = `${root}/src/shell/commands/git-worktree.ts`;
const worktree = await readFile(worktreePath, "utf8");
await writeFile(
  worktreePath,
  worktree.replace(
    /export async function gitAdd[\s\S]*?(?=export async function gitStatus)/,
    `export async function gitAdd(repo: GitRepository, argv: readonly string[]) {
  const args = gitArguments(argv, ["-A", "--all"]);
  gitOperands(args, args.flags.size === 0 ? 1 : 0, Number.MAX_SAFE_INTEGER);
  const paths = args.operands.length === 0 ? ["."] : args.operands.map((path) => relativePath(repo, path));
  const matrix = await gitMatrix(repo);
  const selected = matrix.filter(([path]) => paths.some((prefix) => prefix === "." || path === prefix || path.startsWith(prefix + "/")));
  for (let start = 0; start < selected.length; start += 32) {
    repo.fs.check();
    const batch = selected.slice(start, start + 32);
    const existing = batch.filter(([, , work]) => work !== 0).map(([path]) => path);
    if (existing.length > 0) await git.add({ ...repo, filepath: existing });
    for (const [path, , work] of batch)
      if (work === 0) await git.remove({ ...repo, filepath: path });
  }
  for (const path of paths) {
    if (path !== "." && !matrix.some(([name]) => name === path || name.startsWith(path + "/")))
      await git.add({ ...repo, filepath: path });
  }
}

`,
  ),
);
