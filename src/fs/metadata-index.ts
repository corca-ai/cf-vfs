import { VfsError } from "../core/errors.js";
import type { ChangePage, StatManyResult, VfsStat, VirtualFileSystem } from "../vfs/types.js";

/**
 * Opt-in host-side namespace index. Requires the trusted change-feed capability;
 * never use its snapshots to authorize reads or writes. Refresh is synchronous,
 * so a local VFS cannot mutate between taking the cursor and reading metadata.
 * The feed must cover all visible changes; flush pending document overlays first.
 */
export class FsMetadataIndex {
  private entries = new Map<string, VfsStat>();
  private cursor = 0;
  private initialized = false;

  constructor(
    private readonly fileSystem: VirtualFileSystem,
    private readonly maximum = 100_000,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new VfsError("EINVAL", "metadata index capacity must be a positive safe integer");
  }

  /** Returns only changed metadata; the initial refresh returns the namespace. */
  refresh(): { updated: VfsStat[]; removed: string[] } {
    const { cursor, paths } = this.readChanges();
    if (!this.initialized) return this.initialize(cursor);
    const { updated, removed } = this.readChanged(paths);
    const size =
      this.entries.size -
      removed.filter((path) => this.entries.has(path)).length +
      updated.filter((stat) => !this.entries.has(stat.path)).length;
    if (size > this.maximum) throw new VfsError("E2BIG", "metadata index capacity exceeded");
    for (const path of removed) this.entries.delete(path);
    for (const stat of updated) this.entries.set(stat.path, { ...stat });
    this.cursor = cursor;
    return { updated, removed };
  }

  private readChanges() {
    const changed = new Set<string>();
    let cursor = this.cursor;
    let page: ChangePage;
    do {
      page = this.fileSystem.changesSince(cursor);
      for (const change of page.changes) changed.add(change.path);
      if (changed.size > Math.max(this.maximum, 1000))
        throw new VfsError("E2BIG", "metadata refresh capacity exceeded");
      cursor = page.cursor;
    } while (page.more);
    return { cursor, paths: [...changed] };
  }

  private readChanged(paths: readonly string[]) {
    const updated: VfsStat[] = [];
    const removed: string[] = [];
    for (let at = 0; at < paths.length; at += 1000) {
      const batch = paths.slice(at, at + 1000);
      const results = this.fileSystem.statMany?.(batch, { follow: false });
      for (const [index, path] of batch.entries()) {
        const stat = this.changedStat(path, results?.[index]);
        if (stat === undefined) removed.push(path);
        else updated.push(stat);
      }
    }
    return { updated, removed };
  }

  private changedStat(path: string, result: StatManyResult | undefined): VfsStat | undefined {
    try {
      if (result !== undefined && "error" in result)
        throw new VfsError(result.error.code, result.error.message, result.error.path);
      return result !== undefined ? result.stat : this.fileSystem.lstat(path);
    } catch (error) {
      if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
      return undefined;
    }
  }

  /** Copies metadata; holding it neither pins file bodies nor grants access. */
  snapshot(): VfsStat[] {
    return [...this.entries.values()].map((stat) => ({ ...stat }));
  }

  private initialize(cursor: number): { updated: VfsStat[]; removed: string[] } {
    const entries = new Map<string, VfsStat>();
    let next: string | undefined;
    do {
      const page = this.fileSystem.findPage({
        path: "/",
        includeRoot: true,
        limit: 1000,
        ...(next === undefined ? {} : { cursor: next }),
      });
      for (const stat of page.entries)
        entries.set(
          stat.path,
          stat.contentClass === "opaque" ? this.fileSystem.lstat(stat.path) : stat,
        );
      if (entries.size > this.maximum)
        throw new VfsError("E2BIG", "metadata index capacity exceeded");
      next = page.nextCursor ?? undefined;
    } while (next !== undefined);
    this.entries = entries;
    this.cursor = cursor;
    this.initialized = true;
    return { updated: this.snapshot(), removed: [] };
  }
}
