import { VfsError } from "../core/errors.js";
import { compareUtf8, normalizePath } from "../core/path.js";
import type { ShellBudget, ShellFileSystem, ShellSession } from "./types.js";

export function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]]/gu, (character) => `\\${character}`);
}

function unescapeGlob(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] !== undefined) index += 1;
    output += value[index] ?? "";
  }
  return output;
}

function hasClosingClassBracket(pattern: string, open: number): boolean {
  let escaped = false;
  for (let index = open + 1; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "]") return true;
  }
  return false;
}

function firstGlobMeta(pattern: string): number {
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") escaped = true;
    else if (character === "*" || character === "?") return index;
    else if (character === "[" && hasClosingClassBracket(pattern, index)) return index;
  }
  return -1;
}

export function hasGlob(pattern: string): boolean {
  return firstGlobMeta(pattern) >= 0;
}

function containsDotSegment(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/").map(unescapeGlob);
  const pathSegments = path.split("/");
  return pathSegments.some(
    (segment, index) =>
      segment.startsWith(".") && !(patternSegments[index]?.startsWith(".") ?? false),
  );
}

function relativePath(from: string, to: string): string {
  const fromSegments = from.split("/").filter(Boolean);
  const toSegments = to.split("/").filter(Boolean);
  let common = 0;
  while (fromSegments[common] === toSegments[common] && common < fromSegments.length) common += 1;
  return (
    [
      ...Array.from({ length: fromSegments.length - common }, () => ".."),
      ...toSegments.slice(common),
    ].join("/") || "."
  );
}

interface GlobSearch {
  readonly root: string;
  readonly writtenRoot: string;
  readonly pattern: string;
}

function globSearch(pattern: string, cwd: string, fileSystem: ShellFileSystem): GlobSearch {
  const absolutePattern = normalizePath(pattern, cwd);
  const firstMeta = firstGlobMeta(absolutePattern);
  const escapedPrefix = firstMeta < 0 ? absolutePattern : absolutePattern.slice(0, firstMeta);
  const rootEnd = Math.max(escapedPrefix.lastIndexOf("/"), 0);
  const writtenRoot = rootEnd === 0 ? "/" : unescapeGlob(absolutePattern.slice(0, rootEnd));
  const root = fileSystem.realpath(writtenRoot);
  const suffix = absolutePattern.slice(rootEnd);
  return { root, writtenRoot, pattern: root === "/" ? suffix || "/" : `${root}${suffix}` };
}

function writtenGlobPath(search: GlobSearch, path: string): string {
  if (search.root === search.writtenRoot) return path;
  const tail = search.root === "/" ? path : path.slice(search.root.length);
  return search.writtenRoot === "/" ? tail : `${search.writtenRoot}${tail}`;
}

function scanGlob(search: GlobSearch, fileSystem: ShellFileSystem, budget: ShellBudget): string[] {
  const matches: string[] = [];
  let cursor: string | undefined;
  do {
    const remaining = budget.limits.maxGlobMatches - matches.length;
    const page = fileSystem.findPage({
      path: search.root,
      includeRoot: false,
      pathGlob: search.pattern,
      ...(cursor === undefined ? {} : { cursor }),
      limit: Math.min(1000, remaining + 1),
    });
    budget.step(page.scanned);
    for (const entry of page.entries) {
      if (!containsDotSegment(search.pattern, entry.path)) {
        matches.push(writtenGlobPath(search, entry.path));
      }
    }
    if (matches.length > budget.limits.maxGlobMatches) return matches;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return matches;
}

function displayedGlobPath(value: string, pattern: string, cwd: string, path: string): string {
  if (value.startsWith("/")) return path;
  const relativeMeta = firstGlobMeta(pattern);
  const directoryEnd = pattern.lastIndexOf("/", relativeMeta);
  if (directoryEnd < 0) return relativePath(cwd, path);
  const lexicalDirectory = unescapeGlob(pattern.slice(0, directoryEnd + 1));
  const base = normalizePath(lexicalDirectory, cwd);
  return `${lexicalDirectory}${relativePath(base, path)}`;
}

export async function expandGlob(
  value: string,
  pattern: string,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
): Promise<string[]> {
  const search = globSearch(pattern, session.cwd, fileSystem);
  let matches: string[];
  try {
    matches = scanGlob(search, fileSystem, budget);
  } catch (error) {
    if (error instanceof VfsError && error.code === "ENOENT") return [];
    throw error;
  }
  matches.sort(compareUtf8);
  budget.glob(matches.length);
  return matches.map((path) => displayedGlobPath(value, pattern, session.cwd, path));
}
