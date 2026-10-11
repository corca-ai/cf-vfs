import type { ShellFileSystem } from "./types.js";

// Private cache ownership, never a capability to access the unscoped filesystem.
const roots = new WeakMap<object, object>();
const views = new WeakMap<ShellFileSystem, object>();
export function registerFileSystemOrigin(view: ShellFileSystem, root: object): void {
  let identity = roots.get(root);
  if (identity === undefined) {
    identity = {};
    roots.set(root, identity);
  }
  views.set(view, identity);
}
export function fileSystemOrigin(view: ShellFileSystem): object {
  return views.get(view) ?? view;
}

/** Compare ownership without exposing the host filesystem to an applet. */
export function hasFileSystemOrigin(view: ShellFileSystem, root: object): boolean {
  return views.get(view) === roots.get(root) && roots.has(root);
}
