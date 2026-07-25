import { VfsError } from "../core/errors.js";
import { dirname, isDescendant, normalizePath } from "../core/path.js";
import type {
  AppendFileOptions,
  ByteBody,
  CopyOptions,
  CopyResult,
  EntryPage,
  FindOptions,
  InlineReadResult,
  MetadataUpdateOptions,
  MoveOptions,
  MoveResult,
  PageOptions,
  RemoveOptions,
  RemoveResult,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
  VirtualFileSystem,
  WriteFileOptions,
  WriteResult,
} from "../vfs/types.js";
import type { ShellBudget, ShellFileSystem, ShellPolicy } from "./types.js";

function allowed(path: string, roots: readonly string[] | undefined): boolean {
  if (roots === undefined) return true;
  const normalized = normalizePath(path);
  return roots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return normalized === normalizedRoot || isDescendant(normalizedRoot, normalized);
  });
}

export class ScopedFileSystem implements ShellFileSystem {
  readonly #inner: VirtualFileSystem;
  readonly #policy: ShellPolicy;
  readonly #budget: ShellBudget;

  constructor(inner: VirtualFileSystem, policy: ShellPolicy, budget: ShellBudget) {
    this.#inner = inner;
    this.#policy = policy;
    this.#budget = budget;
  }

  /**
   * The path a root check has to be made against.
   *
   * A link inside an allowed root can name anything at all, so checking the
   * path as written would let `/allowed/escape -> /etc` hand out the whole
   * namespace. The check is made against what the path actually resolves to.
   * The written form is checked too, so a caller naming an out-of-bounds path
   * directly still gets the error that names what they asked for.
   */
  #resolved(path: string, follow = true): string {
    try {
      return this.#inner.realpath(path, { follow });
    } catch {
      // A path that cannot be resolved — a loop, or a missing parent — is
      // refused by the operation itself; the root check uses the written form
      // so the diagnostic is about the roots and not about the link.
      return normalizePath(path);
    }
  }

  /**
   * Checks the roots for an operation that acts on a link rather than through
   * it.
   *
   * `lstat` and `readlink` answer questions about the link itself, so the
   * check is about where the link lives, not where it points — refusing them
   * would be inconsistent with `ls -l`, which shows the same target text for
   * every entry in a readable directory. Everything on the way to the link is
   * still resolved, so an escaping directory link cannot be used to reach one.
   */
  private readLink(path: string): void {
    const resolved = this.#resolved(path, false);
    if (!allowed(path, this.#policy.readRoots) || !allowed(resolved, this.#policy.readRoots)) {
      throw new VfsError("EACCES", "path is outside the readable roots", normalizePath(path));
    }
  }

  private read(path: string): void {
    const resolved = this.#resolved(path);
    if (!allowed(path, this.#policy.readRoots) || !allowed(resolved, this.#policy.readRoots)) {
      throw new VfsError("EACCES", "path is outside the readable roots", normalizePath(path));
    }
  }

  private write(path: string): void {
    const resolved = this.#resolved(path);
    if (!allowed(path, this.#policy.writeRoots) || !allowed(resolved, this.#policy.writeRoots)) {
      throw new VfsError("EACCES", "path is outside the writable roots", normalizePath(path));
    }
  }

  private missingDirectoryCount(path: string, recursive: boolean): number {
    const normalized = normalizePath(path);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const candidates = recursive
      ? segments.map((_segment, index) => `/${segments.slice(0, index + 1).join("/")}`)
      : [normalized];
    let missing = 0;
    for (const candidate of candidates) {
      this.write(candidate);
      try {
        this.#inner.stat(candidate);
      } catch (error) {
        if (error instanceof VfsError && error.code === "ENOENT") missing += 1;
        else throw error;
      }
    }
    return missing;
  }

  getMutationToken(path: string) {
    const resolved = this.#resolved(path);
    const scoped = (candidate: string): boolean =>
      allowed(candidate, this.#policy.readRoots) || allowed(candidate, this.#policy.writeRoots);
    if (!scoped(path) || !scoped(resolved)) {
      throw new VfsError("EACCES", "path is outside the scoped roots", normalizePath(path));
    }
    return this.#inner.getMutationToken(path);
  }

  lstat(path: string) {
    this.readLink(path);
    return this.#inner.lstat(path);
  }

  readlink(path: string) {
    this.readLink(path);
    return this.#inner.readlink(path);
  }

  realpath(path: string, options?: { follow?: boolean }) {
    this.read(path);
    return this.#inner.realpath(path, options);
  }

  symlink(path: string, target: string, options?: SymlinkOptions) {
    this.write(path);
    // The link is created inside the roots, but what it names is checked when
    // it is followed rather than here: a link may point anywhere, and a policy
    // that changes later must still govern what the link reaches.
    return this.#inner.symlink(path, target, options);
  }

  inspectWriteTarget(path: string): VfsStat | null {
    const normalized = normalizePath(path);
    this.write(normalized);
    const parent = this.#inner.stat(dirname(normalized));
    if (parent.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent.path);
    try {
      return this.#inner.stat(normalized);
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return null;
      throw error;
    }
  }

  stat(path: string) {
    this.read(path);
    return this.#inner.stat(path);
  }

  list(path: string) {
    this.read(path);
    return this.#inner.list(path);
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    this.read(path);
    return this.#inner.listPage(path, options);
  }

  find(options: FindOptions) {
    this.read(options.path);
    return this.#inner.find(options);
  }

  findPage(options: FindOptions): EntryPage {
    this.read(options.path);
    return this.#inner.findPage(options);
  }

  countSubtree(path: string): number {
    this.read(path);
    return this.#inner.countSubtree(path);
  }

  readFile(path: string): InlineReadResult {
    this.read(path);
    return this.#inner.readFile(path);
  }

  writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.writeFile(path, body, options);
  }

  appendFile(path: string, body: ByteBody, options?: AppendFileOptions): Promise<WriteResult> {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.appendFile(path, body, options);
  }

  touch(path: string, options?: TouchOptions): VfsStat {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.touch(path, options);
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.setMetadata(path, options);
  }

  mkdir(path: string, recursive?: boolean, mode?: number): VfsStat {
    this.write(path);
    const mutations = this.missingDirectoryCount(path, recursive === true);
    if (mutations > 0) this.#budget.mutation(mutations);
    return this.#inner.mkdir(path, recursive, mode);
  }

  remove(path: string, options?: RemoveOptions): Promise<RemoveResult> {
    this.write(path);
    const count = options?.recursive === true ? this.#inner.countSubtree(path) : 1;
    this.#budget.mutation(Math.max(1, count));
    return this.#inner.remove(path, options);
  }

  move(from: string, to: string, options?: MoveOptions): Promise<MoveResult> {
    this.write(from);
    this.write(to);
    this.#budget.mutation(Math.max(1, this.#inner.countSubtree(from)));
    return this.#inner.move(from, to, options);
  }

  copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult> {
    this.read(from);
    this.write(to);
    this.#budget.mutation(Math.max(1, this.#inner.countSubtree(from)));
    return this.#inner.copy(from, to, options);
  }
}
