import { hasDotSegments } from "../core/path.js";
import { statResult, validateStatPaths } from "../vfs/stat-many.js";
import type { InlineFileBody, ReadManyOptions, StatManyOptions, VfsStat } from "../vfs/types.js";
import type { ShellFileSystem } from "./types.js";

/** An absolute, canonical path outside the overlay's reserved roots. */
export function ordinaryPath(path: string, roots: readonly string[]): boolean {
  return (
    path.startsWith("/") &&
    !path.includes("\0") &&
    !hasDotSegments(path) &&
    !path.includes("//") &&
    !path.endsWith("/") &&
    !roots.some((name) => path === `/${name}` || path.startsWith(`/${name}/`))
  );
}

/** Preserve reserved paths and link-following behavior at the shell overlay. */
export function readStatBatch(
  inner: ShellFileSystem,
  paths: readonly string[],
  options: StatManyOptions,
  roots: readonly string[],
  read: (path: string) => VfsStat,
) {
  validateStatPaths(paths);
  const ordinary = options.follow === false && paths.every((path) => ordinaryPath(path, roots));
  if (ordinary && inner.statMany !== undefined) return inner.statMany(paths, options);
  return paths.map((path) => statResult(() => read(path)));
}

/**
 * Reads in bulk only the paths `keep` admits, leaving every other path
 * `undefined` so the caller reads it through `readFile` and its checks.
 */
export function readBodiesWhere(
  inner: Pick<ShellFileSystem, "readMany">,
  paths: readonly string[],
  options: ReadManyOptions | undefined,
  keep: (path: string) => boolean,
): (InlineFileBody | undefined)[] {
  validateStatPaths(paths, "readMany");
  const kept = paths.map(keep);
  const bodies = inner.readMany?.(
    paths.filter((_, index) => kept[index]),
    options,
  );
  let at = 0;
  return kept.map((admitted) => (admitted ? bodies?.[at++] : undefined));
}
