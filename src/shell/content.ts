import { VfsError } from "../core/errors.js";
import type { ByteRange, VfsStat } from "../vfs/types.js";
import type { ShellFileSystem } from "./types.js";

/**
 * One opened body, and the lease that keeps it readable.
 *
 * `release` is not optional politeness: an opaque read holds a retention lease
 * against garbage collection, and a caller that abandons the stream without
 * releasing keeps the object alive until the lease expires on its own.
 */
export interface ContentBody {
  readonly stat: VfsStat;
  readonly stream: ReadableStream<Uint8Array>;
  release(): void;
}

/**
 * The capability that lets a streaming command read an opaque R2 body.
 *
 * Deliberately the narrowest thing that works: it opens one body for one path
 * that already exists in the namespace. There is no listing, no upload, no key
 * construction, and no bucket handle, so a command holding this cannot
 * discover an object the namespace does not name, cannot create one, and
 * cannot delete one. That is what makes it safe to hand to a utility.
 *
 * It is separate from `ShellFileSystem` on purpose. The type is structural, so
 * a shell built for inline content never mentions this and never pulls the R2
 * adapter into its bundle.
 */
export interface ShellContentReader {
  /**
   * Opens a body, optionally a byte range of it.
   *
   * A range is a request, not a guarantee: an implementation that cannot serve
   * one returns the whole body, and the caller must still skip what it did not
   * want. Reporting a range that was not applied would be worse than not
   * applying it.
   */
  open(path: string, range?: ByteRange): Promise<ContentBody>;
}

/**
 * How much of an opaque body a session may read.
 *
 * Three independent answers rather than one, because they are three different
 * risks: naming a file, reading bytes SQLite holds, and reading bytes R2 holds
 * on someone else's budget. An application that wants `ls` and `stat` to see
 * an archive without letting `cat` stream gigabytes of it can say exactly
 * that.
 */
export type OpaqueContentAccess = "none" | "metadata" | "stream";

/**
 * Opens a path's content, using the opaque capability only when allowed.
 *
 * This is the single place the decision is made. An inline file is read the
 * way it always was; an opaque one is streamed when a session has both the
 * capability and the permission, and otherwise reports the same `ENOTSUP` it
 * reported before this existed — which is what keeps the default unchanged.
 */
export async function openContent(
  fileSystem: ShellFileSystem,
  path: string,
  options: {
    readonly reader?: ShellContentReader | undefined;
    readonly access?: OpaqueContentAccess | undefined;
    readonly range?: ByteRange | undefined;
  } = {},
): Promise<ContentBody> {
  const stat = fileSystem.stat(path);
  if (stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
  if (stat.kind !== "file" || stat.contentClass !== "opaque") {
    const inline = fileSystem.readFile(path);
    return { stat: inline.stat, stream: inline.stream, release: () => undefined };
  }
  if (options.reader === undefined || (options.access ?? "metadata") !== "stream") {
    throw new VfsError("ENOTSUP", "opaque R2 content is not available to shell commands", path);
  }
  return options.reader.open(path, options.range);
}
