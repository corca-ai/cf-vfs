import * as git from "isomorphic-git";
import type { GitRepository } from "./git-repository.js";

/**
 * The engine locks indexes by pathname in module state. A DO reset during
 * checkout can abandon that lock while the module survives. Keep checkout's
 * engine-only metadata paths unique; the adapter still accesses the real VFS.
 * Hosts must serialize checkout with other repository operations and edits.
 */
export async function checkoutGit(
  repo: GitRepository,
  options: Pick<Parameters<typeof git.checkout>[0], "ref" | "force" | "dryRun">,
) {
  const gitdir = `${repo.gitdir}/.checkout-${crypto.randomUUID()}`;
  const translate = (path: string) =>
    path === gitdir || path.startsWith(`${gitdir}/`)
      ? repo.gitdir + path.slice(gitdir.length)
      : path;
  const promises = new Proxy(repo.fs.promises, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const index = property === "symlink" ? 1 : 0;
        const path = args[index];
        if (typeof path === "string") args[index] = translate(path);
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  repo.fs.beginCheckoutWrites(repo.dir, repo.gitdir);
  try {
    return await git.checkout({ ...repo, ...options, fs: { promises }, gitdir });
  } finally {
    repo.fs.endCheckoutWrites();
  }
}
