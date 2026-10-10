import * as git from "isomorphic-git";
import { VfsError } from "../../core/errors.js";
import { compareUtf8 } from "../../core/path.js";
import type { GitRepository } from "./git-repository.js";

/** Compare actual bytes: the engine's stat cache compares only whole seconds. */
export async function gitMatrix(
  repo: GitRepository,
  paths: readonly string[] = ["."],
  stagingSizes?: Map<string, number>,
) {
  const rows: Array<[string, number, number, number]> = [];
  const ignoreFs = missingIgnoreProbes(repo);
  const inspectWork = boundedWorkIdentity();
  const relevant = (path: string) =>
    path === "." ||
    paths.some(
      (prefix) =>
        prefix === "." ||
        path === prefix ||
        path.startsWith(`${prefix}/`) ||
        prefix.startsWith(`${path}/`),
    );
  await git.walk({
    ...repo,
    trees: [git.TREE({ ref: "HEAD" }), git.WORKDIR(), git.STAGE()],
    iterate: async (walk, children) => {
      const selected = [];
      for (const child of children) {
        // The engine passes pathname unions here, before constructing entries
        // and statting them. Its declaration incorrectly calls them entries.
        const names: readonly unknown[] = child;
        const path = names.find((name): name is string => typeof name === "string");
        // If a compatible engine starts passing constructed entries as its
        // declarations promise, let map perform the same pruning instead.
        if (path === undefined || (path !== ".git" && !path.startsWith(".git/") && relevant(path)))
          selected.push(walk(child));
      }
      return await Promise.all(selected);
    },
    map: async (path, entries) => {
      repo.fs.check();
      if (path === ".git" || path.startsWith(".git/")) return null;
      // Keep ancestors so walkers can reach an operand, but do not read or
      // hash unrelated subtrees when staging a selected path.
      if (!relevant(path)) return null;
      const [head, , stage] = entries;
      const types = await Promise.all(entries.map((entry) => entry?.type()));
      if (path === "." || types.includes("tree")) return;
      if (
        head === null &&
        stage === null &&
        (await git.isIgnored({ ...repo, fs: ignoreFs, filepath: path }))
      )
        return;
      rows.push(await matrixRow(path, entries, inspectWork, stagingSizes));
      return undefined;
    },
  });
  return rows.sort((a, b) => compareUtf8(a[0], b[0]));
}

async function matrixRow(
  path: string,
  entries: readonly (git.WalkerEntry | null | undefined)[],
  inspectWork: typeof workIdentity,
  stagingSizes?: Map<string, number>,
): Promise<[string, number, number, number]> {
  const [head, work, stage] = entries;
  // A new blob necessarily differs from an absent index entry. The staging
  // engine reads/hashes it once with normal permissions and autocrlf handling.
  if (
    stagingSizes !== undefined &&
    head == null &&
    stage == null &&
    work != null &&
    (await work.type()) === "blob"
  ) {
    stagingSizes.set(path, (await work.stat()).size);
    return [path, 0, 2, 0];
  }
  const h = await entryIdentity(head),
    i = await entryIdentity(stage);
  const w = await inspectWork(work);
  const workColumn = matrixColumn(h, w),
    stageColumn = matrixColumn(h, i, w);
  if (stagingSizes !== undefined && work != null && workColumn !== stageColumn)
    stagingSizes.set(path, (await work.stat()).size);
  return [path, h === undefined ? 0 : 1, workColumn, stageColumn];
}

async function entryIdentity(entry: git.WalkerEntry | null | undefined) {
  return entry == null ? undefined : `${await entry.mode()}:${await entry.oid()}`;
}

export async function requireCleanGitTree(repo: GitRepository) {
  const dirty = (await gitMatrix(repo)).some(
    ([, head, work, stage]) => head !== work || work !== stage,
  );
  if (dirty) throw new VfsError("EEXIST", "git: operation requires a clean working tree and index");
}

export function gitStatusCode(head: number, work: number, stage: number) {
  if (head === 0 && stage === 0) return "??";
  const index = head === stage ? " " : head === 0 ? "A" : stage === 0 ? "D" : "M";
  const tree = work === stage ? " " : work === 0 ? "D" : "M";
  return `${index}${tree}`;
}

async function workIdentity(entry: git.WalkerEntry | null | undefined) {
  const body = await entry?.content();
  return body ? `${await entry?.mode()}:${(await git.hashBlob({ object: body })).oid}` : undefined;
}

/** Bound body collection and native hashes without serializing metadata walks. */
function boundedWorkIdentity(): typeof workIdentity {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (entry) => {
    if (entry == null) return undefined;
    if (active < 32) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await workIdentity(entry);
    } finally {
      // Hand off the reserved slot before admitting a fresh caller.
      const next = waiting.shift();
      if (next === undefined) active--;
      else next();
    }
  };
}
function matrixColumn(head: string | undefined, value: string | undefined, work?: string) {
  if (value === undefined) return 0;
  if (value === head) return 1;
  return work === undefined || value === work ? 2 : 3;
}

/** Negative probes are stable only within this read-only inspection phase. */
function missingIgnoreProbes(repo: GitRepository) {
  const memoizeMissing = <T>(read: (path: string) => Promise<T>) => {
    const missing = new Map<string, Promise<T>>();
    return (path: string): Promise<T> => {
      const cached = missing.get(path);
      if (cached !== undefined) {
        repo.fs.check();
        return cached;
      }
      if (missing.size >= 128) return read(path);
      const pending = read(path).then(
        (value) => {
          missing.delete(path);
          return value;
        },
        (error: unknown) => {
          if (!(error instanceof VfsError) || error.code !== "ENOENT") missing.delete(path);
          throw error;
        },
      );
      missing.set(path, pending);
      return pending;
    };
  };
  return {
    promises: {
      ...repo.fs.promises,
      // Git's ignore reader requests UTF-8; successful bodies are never retained.
      readFile: memoizeMissing((path) => repo.fs.promises.readFile(path, "utf8")),
      stat: memoizeMissing(repo.fs.promises.stat),
      lstat: memoizeMissing(repo.fs.promises.lstat),
    },
  };
}
