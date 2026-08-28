import { isVfsError, VfsError } from "../core/errors.js";
import type { ByteRange, VfsStat } from "../vfs/types.js";
import type { ShellFileSystem } from "./types.js";

/**
 * One opened body.
 *
 * There is no release call, because there is nothing a caller could release: a
 * retention lease is a deadline written into the row, and nothing lowers it
 * early. A caller that stops reading should cancel the stream — that is what
 * stops the transfer — and the lease lapses on its own.
 */
export interface ContentBody {
  readonly stat: VfsStat;
  readonly stream: ReadableStream<Uint8Array>;
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
  open(path: string, range?: ByteRange, signal?: AbortSignal): Promise<ContentBody>;
}

/**
 * How much of an opaque body a session may read.
 *
 * Two answers, not three: whether a path can be named at all is what the read
 * roots decide, and adding a third value here that did the same thing would be
 * a setting with no effect. `metadata` — the default — lets `ls` and `stat`
 * describe an archive without letting `cat` stream gigabytes of it.
 */
export type OpaqueContentAccess = "metadata" | "stream";

/**
 * A reader that answers only for paths the session may already read.
 *
 * The reader a host supplies is built over the unscoped filesystem, because
 * that is where the lease and the object metadata live. Handing it to an
 * applet unchanged would be a read capability with no roots on it — a command
 * could open a body the session cannot name. This wraps it so the same check
 * every other read passes runs first.
 */
export function scopedContentReader(
  reader: ShellContentReader,
  assertReadable: (path: string) => void,
): ShellContentReader {
  return {
    async open(path, range, signal) {
      assertReadable(path);
      return reader.open(path, range, signal);
    },
  };
}

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
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<ContentBody> {
  // Without a reader, or without permission to stream through one, the only
  // body that can be served is inline — and `readFile` raises the same EISDIR
  // and ENOTSUP this would have probed for. Asking first would resolve the
  // path once to decide, and once more to read.
  if (options.reader === undefined || (options.access ?? "metadata") !== "stream") {
    return openInline(fileSystem, path, options.range);
  }
  // `readFile` is also the VFS's ordinary read-permission check. An opaque
  // entry answers ENOTSUP only after that check, which prevents a separately
  // supplied R2 reader (built over the trusted raw VFS) from bypassing DAC.
  try {
    return openInline(fileSystem, path, options.range);
  } catch (error) {
    if (!isVfsError(error) || error.code !== "ENOTSUP") throw error;
  }
  return options.reader.open(path, options.range, options.signal);
}

/**
 * Reads an inline body, reporting a refusal against the path the caller named.
 *
 * `readFile` resolves links before it refuses, so its `EISDIR` and `ENOTSUP`
 * name what the path led to. A utility's diagnostic is about its operand —
 * `cat dirlink` is a complaint about `dirlink` — so those two are restated
 * here. Every other failure already names the operand and is left alone.
 */
function openInline(fileSystem: ShellFileSystem, path: string, range?: ByteRange): ContentBody {
  try {
    const inline = fileSystem.readFile(path, range === undefined ? undefined : { range });
    return { stat: inline.stat, stream: inline.stream };
  } catch (error) {
    if (isVfsError(error) && (error.code === "EISDIR" || error.code === "ENOTSUP")) {
      throw new VfsError(error.code, error.message, path);
    }
    throw error;
  }
}
