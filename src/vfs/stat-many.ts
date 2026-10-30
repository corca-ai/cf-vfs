import { VfsError } from "../core/errors.js";
import { hasDotSegments, normalizePath, pathRequiresDirectory } from "../core/path.js";
import type { StatManyResult, VfsStat } from "./types.js";

export function statResult(read: () => VfsStat): StatManyResult {
  try {
    return { stat: read() };
  } catch (error) {
    if (!(error instanceof VfsError) || error.name !== "VfsError") throw error;
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
      },
    };
  }
}

export function validateStatPaths(paths: readonly string[], operation = "statMany"): void {
  if (!Array.isArray(paths) || paths.length > 1000)
    throw new VfsError("E2BIG", `${operation} accepts at most 1000 paths`);
  for (const path of paths)
    if (typeof path !== "string")
      throw new VfsError("EINVAL", `${operation} paths must be strings`);
}

/** SQLite text bindings can replace lone surrogates; keep ordinary resolution there. */
export function canonicalStatPaths(paths: readonly string[]): string[] | undefined {
  const canonical: string[] = [];
  try {
    for (const path of paths) {
      if (hasDotSegments(path) || pathRequiresDirectory(path) || /[\uD800-\uDFFF]/u.test(path))
        return undefined;
      canonical.push(normalizePath(path));
    }
  } catch (error) {
    if (!(error instanceof VfsError)) throw error;
    return undefined;
  }
  return canonical;
}
