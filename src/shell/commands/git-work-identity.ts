import * as git from "isomorphic-git";
import { fileSystemOrigin } from "../fs-origin.js";
import type { GitRepository } from "./git-repository.js";

interface Identity {
  readonly token: string;
  readonly ino: number;
  readonly oid: string;
  readonly conversion: unknown;
}
const capacity = 4096;
const filesystems = new WeakMap<object, Map<string, Identity>>();

/** Content hashes belong to one filesystem view's owner and its opaque tokens. */
export function cachedWorkIdentity(repo: GitRepository) {
  const origin = fileSystemOrigin(repo.fs.context.fileSystem);
  let identities = filesystems.get(origin);
  if (identities === undefined) {
    identities = new Map();
    filesystems.set(origin, identities);
  }
  const cache = identities;
  repo.fs.beginWorkReads(capacity);
  let config: Promise<unknown> | undefined;
  return async (entry: git.WalkerEntry, path: string): Promise<string | undefined> => {
    const mode = await entry.mode();
    const full = `${repo.dir}/${path}`;
    const ordinary = (mode & 0o170000) === 0o100000;
    config ??= git.getConfig({ ...repo, path: "core.autocrlf" });
    const conversion = await config;
    const cached = ordinary ? cache.get(full) : undefined;
    const metadata = repo.fs.workStatSnapshot(full);
    if (
      cached !== undefined &&
      cached.conversion === conversion &&
      metadata?.ino === cached.ino &&
      metadata.mutationToken === cached.token
    ) {
      // A read at EOF authorizes access and returns current overlay metadata.
      // Merely statting the file would bypass DAC read permission on a cache hit.
      const read = repo.fs.context.fileSystem.readFile(full, {
        range: { offset: Number.MAX_SAFE_INTEGER },
      });
      await read.stream.cancel();
      if (read.stat.ino === cached.ino && read.stat.mutationToken === cached.token) {
        repo.fs.check();
        const release = repo.fs.context.budget.buffered(read.stat.sizeBytes);
        release();
        repo.fs.context.budget.io(read.stat.sizeBytes);
        return `${mode}:${cached.oid}`;
      }
    }
    const body = await entry.content();
    if (body === undefined) return undefined;
    const oid = (await git.hashBlob({ object: body })).oid;
    const snapshot = repo.fs.workReadSnapshot(full);
    if (ordinary && snapshot !== undefined && (cache.size < capacity || cache.has(full))) {
      cache.set(full, { ino: snapshot.ino, token: snapshot.mutationToken, oid, conversion });
    }
    return `${mode}:${oid}`;
  };
}
