import { VfsError } from "./errors.js";

const MAX_PATH_BYTES = 4096;
const MAX_NAME_BYTES = 255;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) break;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function validatePath(path: string): void {
  if (path.includes("\0")) {
    throw new VfsError("EINVAL", "paths cannot contain NUL bytes", path);
  }
  if (utf8Length(path) > MAX_PATH_BYTES) {
    throw new VfsError("ENAMETOOLONG", `path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`, path);
  }
}

export function normalizePath(path: string, cwd = "/"): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new VfsError("EINVAL", "path must be a non-empty string");
  }
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  const segments: string[] = [];

  for (const segment of absolute.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    if (utf8Length(segment) > MAX_NAME_BYTES) {
      throw new VfsError(
        "ENAMETOOLONG",
        `path segment exceeds ${MAX_NAME_BYTES} UTF-8 bytes`,
        path,
      );
    }
    segments.push(segment);
  }

  const normalized = `/${segments.join("/")}`;
  validatePath(normalized);
  return normalized;
}

export function pathRequiresDirectory(path: string): boolean {
  return path.length > 1 && path.endsWith("/");
}

export function normalizePathPreservingTrailingSlash(path: string, cwd = "/"): string {
  const normalized = normalizePath(path, cwd);
  return normalized !== "/" && pathRequiresDirectory(path) ? `${normalized}/` : normalized;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const separator = normalized.lastIndexOf("/");
  return separator === 0 ? "/" : normalized.slice(0, separator);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function depthFrom(root: string, path: string): number {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (normalizedRoot === normalizedPath) return 0;
  const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) {
    throw new VfsError("EINVAL", `${normalizedPath} is not below ${normalizedRoot}`);
  }
  return normalizedPath.slice(prefix.length).split("/").length;
}

export function isDescendant(root: string, path: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (normalizedRoot === "/") return normalizedPath !== "/";
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function descendantRange(root: string): { lower: string; upper: string } {
  const normalized = normalizePath(root);
  if (normalized === "/") return { lower: "/", upper: "0" };
  return { lower: `${normalized}/`, upper: `${normalized}0` };
}
