import { dirname, normalizePath } from "../core/path.js";

/** A resolved path has already passed normalization and byte-length checks. */
export function canonicalTraversalAncestors(path: string): string[] {
  if (path === "/") return [];
  const parents: string[] = [];
  let separator = path.lastIndexOf("/");
  while (separator > 0) {
    parents.push(path.slice(0, separator));
    separator = path.lastIndexOf("/", separator - 1);
  }
  parents.push("/");
  return parents;
}

export function traversalAncestors(path: string, followed: readonly string[]): string[] {
  if (followed.length === 0) return canonicalTraversalAncestors(path);
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
