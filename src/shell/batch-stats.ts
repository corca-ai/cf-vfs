import { statResult, validateStatPaths } from "../vfs/stat-many.js";
import type { StatManyOptions, VfsStat } from "../vfs/types.js";
import type { ShellFileSystem } from "./types.js";

/** Preserve reserved paths and link-following behavior at the shell overlay. */
export function readStatBatch(
  inner: ShellFileSystem,
  paths: readonly string[],
  options: StatManyOptions,
  roots: readonly string[],
  read: (path: string) => VfsStat,
) {
  validateStatPaths(paths);
  const ordinary =
    options.follow === false &&
    paths.every(
      (path) =>
        path.startsWith("/") &&
        !path.includes("\0") &&
        !hasDotSegments(path) &&
        !path.includes("//") &&
        !path.endsWith("/") &&
        !roots.some((name) => path === `/${name}` || path.startsWith(`/${name}/`)),
    );
  if (ordinary && inner.statMany !== undefined) return inner.statMany(paths, options);
  return paths.map((path) => statResult(() => read(path)));
}

import { hasDotSegments } from "../core/path.js";
