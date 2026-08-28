import type { PosixVirtualFileSystem, VirtualFileSystem } from "./types.js";

/** Whether a filesystem publishes the optional POSIX credential-view capability. */
export function supportsPosixCredentials(
  fileSystem: VirtualFileSystem,
): fileSystem is PosixVirtualFileSystem {
  return typeof Reflect.get(fileSystem, "forCredentials") === "function";
}
