import { VfsError } from "../core/errors.js";
import type { WriteFilesEntry, WriteResult } from "../vfs/types.js";
import type { ShellFileSystem } from "./types.js";

/** Validate the entire namespace boundary before delegating an atomic write. */
export function writeCheckedBatch(
  fs: ShellFileSystem,
  entries: readonly WriteFilesEntry[],
  checkPath: (path: string) => void,
): Promise<WriteResult[]> {
  for (const entry of entries) checkPath(entry.path);
  if (fs.writeFiles === undefined) throw new VfsError("ENOTSUP", "batch writes are unavailable");
  return fs.writeFiles(entries);
}
