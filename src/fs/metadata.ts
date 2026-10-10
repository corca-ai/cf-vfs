import { VfsError } from "../core/errors.js";
import { hasDotSegments, normalizePath, pathRequiresDirectory } from "../core/path.js";
import type { VfsEvent } from "../vfs/events.js";
import type { VfsStat, VirtualFileSystem } from "../vfs/types.js";

/**
 * Optional metadata reuse for one filesystem/credential view. Wire onEvent to
 * that filesystem before reading. Content overwrites invalidate their paths;
 * namespace and metadata changes clear all permission checks. No TTL is used.
 */
export class FsMetadataCache {
  private readonly entries = new Map<string, VfsStat>();
  private owner: VirtualFileSystem | undefined;
  private epoch = 0;
  private evictedSinceClear = false;

  constructor(private readonly maxEntries = 4096) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new VfsError("EINVAL", "metadata cache size must be a positive safe integer");
    }
  }

  readonly onEvent = (event: VfsEvent): void => {
    if (event.type !== "vfs.mutation") return;
    if (event.op === "write" && event.subtree === undefined && !this.evictedSinceClear) {
      // Byte overwrites preserve ancestor search checks and path resolution.
      // Hard-link writes announce every affected alias separately.
      this.entries.delete(event.path);
      this.epoch += 1;
    } else this.clear();
  };

  clear(): void {
    this.entries.clear();
    this.evictedSinceClear = false;
    this.epoch += 1;
  }

  /** Never shares successful permission checks across filesystem views. */
  private bind(fileSystem: VirtualFileSystem): void {
    if (this.owner === undefined) this.owner = fileSystem;
    else if (this.owner !== fileSystem) {
      throw new VfsError("EINVAL", "metadata cache belongs to another filesystem view");
    }
  }

  private remember(stat: VfsStat): void {
    this.entries.delete(stat.path);
    this.entries.set(stat.path, { ...stat });
    if (this.entries.size > this.maxEntries) {
      // Once a working set exceeds capacity, retaining its tail across writes
      // makes the next sequential scan evict entries it has yet to visit.
      this.evictedSinceClear = true;
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  stat(fileSystem: VirtualFileSystem, path: string, follow: boolean): VfsStat {
    this.bind(fileSystem);
    const normalized = normalizePath(path);
    const cached =
      pathRequiresDirectory(path) || hasDotSegments(path)
        ? undefined
        : this.entries.get(normalized);
    if (cached !== undefined && (!follow || cached.kind !== "symlink")) {
      this.entries.delete(normalized);
      this.entries.set(normalized, cached);
      return { ...cached };
    }
    const stat = follow ? fileSystem.stat(path) : fileSystem.lstat(path);
    // A followed link describes its target. Caching it under the written link
    // would make lstat return a file, and caching a target read would bypass
    // permissions on its other ancestors. Only exact canonical reads qualify.
    if (stat.path === normalized && (!follow || stat.kind !== "symlink")) this.remember(stat);
    return stat;
  }

  list(fileSystem: VirtualFileSystem, path: string): VfsStat[] {
    this.bind(fileSystem);
    const epoch = this.epoch;
    const entries = fileSystem.list(path);
    // VFS list checks read AND search permission on the directory, plus
    // traversal of its ancestors. Its child rows are safe lstat metadata.
    if (this.epoch === epoch) {
      // Opaque stat adds object metadata that list does not select.
      for (const entry of entries) if (entry.contentClass !== "opaque") this.remember(entry);
    }
    return entries;
  }
}
