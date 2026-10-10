import { dirname, normalizePath } from "../core/path.js";

/** A resolved path has already passed normalization and byte-length checks. */
export function canonicalAncestors(path: string): string[] {
  if (path === "/") return [];
  const parents: string[] = [];
  let slash = path.lastIndexOf("/");
  while (slash > 0) {
    parents.push(path.slice(0, slash));
    slash = path.lastIndexOf("/", slash - 1);
  }
  parents.push("/");
  return parents;
}

export function traversalAncestors(path: string, followed: readonly string[]): string[] {
  if (followed.length === 0) return canonicalAncestors(path);
  const ancestors = new Set<string>();
  for (const candidate of [path, ...followed]) {
    const first = candidate.endsWith("/") ? normalizePath(candidate) : dirname(candidate);
    for (let parent = first; ; parent = dirname(parent)) {
      ancestors.add(parent);
      if (parent === "/") break;
    }
  }
  return [...ancestors];
}
