import * as git from "isomorphic-git";
import { VfsError } from "../../core/errors.js";
import { dirname, normalizePath } from "../../core/path.js";
import type { GitFileSystem } from "./git-fs.js";

export interface GitRepository {
  readonly fs: GitFileSystem;
  readonly dir: string;
  readonly gitdir: string;
}

export function gitExists(fs: GitFileSystem, path: string): boolean {
  fs.check();
  try {
    fs.context.fileSystem.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof VfsError && error.code === "ENOENT") return false;
    throw error;
  }
}

export function gitRepository(fs: GitFileSystem, path: string, parents = true): GitRepository {
  let dir = fs.context.fileSystem.realpath(path);
  for (;;) {
    fs.check();
    if (gitExists(fs, `${dir}/.git/HEAD`)) return { fs, dir, gitdir: normalizePath(`${dir}/.git`) };
    if (gitExists(fs, `${dir}/HEAD`) && gitExists(fs, `${dir}/objects`))
      return { fs, dir, gitdir: dir };
    const parent = dirname(dir);
    if (!parents || parent === dir) throw new VfsError("EINVAL", "git: not a Git repository", path);
    dir = parent;
  }
}

export async function gitIdentity(repo: GitRepository) {
  const env = repo.fs.context.session.env;
  const name = env.get("GIT_AUTHOR_NAME") ?? (await git.getConfig({ ...repo, path: "user.name" }));
  const email =
    env.get("GIT_AUTHOR_EMAIL") ?? (await git.getConfig({ ...repo, path: "user.email" }));
  if (typeof name !== "string" || name === "" || typeof email !== "string" || email === "")
    throw new VfsError("EINVAL", "git: configure user.name and user.email before committing");
  const timestamp = Math.floor(repo.fs.context.now() / 1000);
  return { name, email, timestamp, timezoneOffset: 0 };
}

export async function gitHead(repo: GitRepository): Promise<string | undefined> {
  try {
    return await git.resolveRef({ ...repo, ref: "HEAD" });
  } catch (error) {
    if (error instanceof git.Errors.NotFoundError) return undefined;
    throw error;
  }
}
