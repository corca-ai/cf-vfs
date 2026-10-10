import type { VfsStat } from "../../vfs/types.js";
import type { GitFileSystem } from "./git-fs.js";

/** One transfer's listings, shared with the fallback so glob work is charged once. */
export class GitObjectTree {
  private readonly directories = new Map<string, VfsStat[]>();
  constructor(private readonly fs: GitFileSystem) {}
  consume(path: string): VfsStat[] {
    const entries = this.directories.get(path);
    this.directories.delete(path);
    return entries ?? this.fs.listEntries(path);
  }
  list(path: string): VfsStat[] {
    let entries = this.directories.get(path);
    if (entries === undefined) {
      entries = this.fs.listEntries(path);
      this.directories.set(path, entries);
    }
    return entries;
  }
}

function ordinaryEntry(entry: VfsStat, umask: number): boolean {
  const expected = (entry.kind === "directory" ? 0o40777 : 0o100666) & ~umask;
  return (
    entry.mode === expected &&
    entry.uid === 0 &&
    entry.gid === 0 &&
    (entry.kind === "directory" ||
      (entry.kind === "file" && entry.contentClass === "inline" && (entry.nlink ?? 1) === 1))
  );
}

function inspectTree(fs: GitFileSystem, root: string, tree: GitObjectTree) {
  const directories = [root];
  let bytes = 0,
    largest = 0;
  for (const directory of directories) {
    for (const entry of tree.list(directory)) {
      fs.check();
      if (!ordinaryEntry(entry, fs.context.session.umask)) return undefined;
      if (entry.kind === "directory") directories.push(entry.path);
      else {
        bytes += entry.sizeBytes;
        largest = Math.max(largest, entry.sizeBytes);
      }
    }
  }
  return { bytes, largest };
}

/** Only the empty object store initialized by a fresh clone may be replaced. */
export async function copyFreshGitObjects(
  fs: GitFileSystem,
  from: string,
  to: string,
  tree: GitObjectTree,
): Promise<boolean> {
  const vfs = fs.context.fileSystem;
  if (vfs.canUseBulkOperation?.("copy-source", from) !== true) return false;
  const root = vfs.lstat(from);
  if (root.kind !== "directory" || !ordinaryEntry(root, fs.context.session.umask)) return false;
  const size = inspectTree(fs, from, tree);
  if (size === undefined) return false;
  const placeholders = fs.listEntries(to);
  if (
    placeholders.some(
      (entry) => entry.kind !== "directory" || fs.listEntries(entry.path).length !== 0,
    )
  )
    return false;
  fs.check();
  if (vfs.canUseBulkOperation?.("copy-source", from) !== true) return false;
  fs.context.budget.io(size.bytes * 2);
  const release = fs.context.budget.buffered(size.largest);
  release();
  for (const entry of placeholders) {
    fs.check();
    await vfs.remove(entry.path);
  }
  fs.check();
  await vfs.copy(from, to, { recursive: true, replace: true });
  return true;
}
