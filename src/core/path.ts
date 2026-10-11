import { VfsError } from "./errors.js";
import { encodeUtf8, utf8ByteLength } from "./unicode.js";

const MAX_PATH_BYTES = 4096;
const MAX_NAME_BYTES = 255;
const DOT_COMPONENT = /(?:^|\/)\.\.?(?:\/|$)/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL and non-ASCII paths require full byte validation.
const NON_CANONICAL_ASCII = /\/\/|\/\.\.?(?:\/|$)|[^\x01-\x7f]/;

export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  // UTF-16 and UTF-8 order agree for BMP text without surrogate code units.
  // Supplementary characters and malformed surrogates retain encoded ordering.
  if (!/[\ud800-\udfff]/.test(left) && !/[\ud800-\udfff]/.test(right)) return left < right ? -1 : 1;
  // Short supplementary text can be compared as scalar values without buffers.
  // Longer text keeps native encoding to avoid a long JavaScript prefix scan.
  if (left.length <= 128 && right.length <= 128) return compareShortUtf8(left, right);
  const leftBytes = encodeUtf8(left);
  const rightBytes = encodeUtf8(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) break;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function utf8OrderPoint(point: number): number {
  // TextEncoder replaces each unpaired surrogate with U+FFFD.
  return point >= 0xd800 && point <= 0xdfff ? 0xfffd : point;
}

function compareShortUtf8(left: string, right: string): number {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftPoint = left.codePointAt(leftOffset) ?? 0;
    const rightPoint = right.codePointAt(rightOffset) ?? 0;
    leftOffset += leftPoint > 0xffff ? 2 : 1;
    rightOffset += rightPoint > 0xffff ? 2 : 1;
    const order = utf8OrderPoint(leftPoint) - utf8OrderPoint(rightPoint);
    if (order !== 0) return order;
  }
  return (leftOffset < left.length ? 1 : 0) - (rightOffset < right.length ? 1 : 0);
}

function validatePath(path: string): void {
  if (path.includes("\0")) {
    throw new VfsError("EINVAL", "paths cannot contain NUL bytes", path);
  }
  if (utf8ByteLength(path) > MAX_PATH_BYTES) {
    throw new VfsError("ENAMETOOLONG", `path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`, path);
  }
}

export function normalizePath(path: string, cwd = "/"): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new VfsError("EINVAL", "path must be a non-empty string");
  }
  // A canonical ASCII path this short fits both POSIX byte limits without
  // allocating component arrays. All other spellings retain full validation.
  if (path === "/") return path;
  if (
    path.length <= MAX_NAME_BYTES &&
    path.startsWith("/") &&
    !path.endsWith("/") &&
    !NON_CANONICAL_ASCII.test(path)
  )
    return path;
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  const segments: string[] = [];

  for (const segment of absolute.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    if (utf8ByteLength(segment) > MAX_NAME_BYTES) {
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

/** Dot components must survive until filesystem links have been resolved. */
export function hasDotSegments(path: string): boolean {
  return (path.includes("/.") || path.startsWith(".")) && DOT_COMPONENT.test(path);
}

export function normalizeResolutionPath(path: string, cwd = "/"): string {
  const normalized = normalizePath(path, cwd);
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  if (!hasDotSegments(absolute)) return normalized;
  validatePath(absolute);
  return absolute;
}

/** Preserve filesystem operators and the final directory assertion for callers. */
export function normalizeFileSystemPath(path: string, cwd = "/"): string {
  if (hasDotSegments(path) || (!path.startsWith("/") && hasDotSegments(cwd)))
    return normalizeResolutionPath(path, cwd);
  return normalizePathPreservingTrailingSlash(path, cwd);
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
