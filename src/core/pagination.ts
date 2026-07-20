import { VfsError } from "./errors.js";
import { matchesGlob } from "./glob.js";
import {
  depthFrom,
  dirname,
  isDescendant,
  normalizePath,
  pathRequiresDirectory,
} from "./path.js";
import type { FindPageOptions, VfsStat } from "./types.js";

const DEFAULT_PAGE_LIMIT = 256;
const MAX_PAGE_LIMIT = 1000;

type FindCandidate = Pick<VfsStat, "kind" | "name" | "path">;

export interface ScannedPage<T> {
  candidates: T[];
  nextCursor: string | null;
  scanned: number;
}

export function resolvePageLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new VfsError("EINVAL", "page limit must be a positive integer");
  }
  return Math.min(resolved, MAX_PAGE_LIMIT);
}

function canonicalCursor(cursor: string): string {
  const normalized = normalizePath(cursor);
  if (normalized !== cursor || pathRequiresDirectory(cursor)) {
    throw new VfsError("EINVAL", "cursor is not a canonical path");
  }
  return normalized;
}

export function resolveListCursor(root: string, cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const normalized = canonicalCursor(cursor);
  if (dirname(normalized) !== root) {
    throw new VfsError("EINVAL", "cursor is not a child of the listed directory", normalized);
  }
  return normalized;
}

export function resolveFindCursor(root: string, cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const normalized = canonicalCursor(cursor);
  if (normalized !== root && !isDescendant(root, normalized)) {
    throw new VfsError("EINVAL", "cursor is outside the traversal root", normalized);
  }
  return normalized;
}

export function scanPage<T extends { path: string }>(
  candidates: readonly T[],
  limit: number,
): ScannedPage<T> {
  const scanned = candidates.slice(0, limit);
  let nextCursor: string | null = null;
  if (candidates.length > limit) {
    const finalCandidate = scanned.at(-1);
    if (!finalCandidate) throw new RangeError("page limit must be positive");
    nextCursor = finalCandidate.path;
  }
  return {
    candidates: scanned,
    nextCursor,
    scanned: scanned.length,
  };
}

export function matchesFindPage(
  root: string,
  candidate: FindCandidate,
  options: FindPageOptions,
): boolean {
  return (options.type === undefined || candidate.kind === options.type)
    && (options.maxDepth === undefined || depthFrom(root, candidate.path) <= options.maxDepth)
    && matchesGlob(candidate.name, options.name)
    && matchesGlob(candidate.path, options.pathGlob);
}
