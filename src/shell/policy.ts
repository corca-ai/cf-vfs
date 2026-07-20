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

  private read(path: string): void {
    if (!allowed(path, this.#policy.readRoots)) {
      throw new VfsError("EACCES", "path is outside the readable roots", normalizePath(path));
    }
  }

  private write(path: string): void {
    if (!allowed(path, this.#policy.writeRoots)) {
      throw new VfsError("EACCES", "path is outside the writable roots", normalizePath(path));
    }
  }

  private async missingDirectoryCount(path: string, recursive: boolean): Promise<number> {
    const normalized = normalizePath(path);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const candidates = recursive
      ? segments.map((_segment, index) => `/${segments.slice(0, index + 1).join("/")}`)
      : [normalized];
    let missing = 0;
    for (const candidate of candidates) {
      this.write(candidate);
      try {
        await this.#inner.stat(candidate);
      } catch (error) {
        if (error instanceof VfsError && error.code === "ENOENT") missing += 1;
        else throw error;
      }
    }
    return missing;
  }

  getMutationToken(path: string) {
    if (!allowed(path, this.#policy.readRoots) && !allowed(path, this.#policy.writeRoots)) {
      throw new VfsError("EACCES", "path is outside the scoped roots", normalizePath(path));
    }
    return this.#inner.getMutationToken(path);
  }

  async inspectWriteTarget(path: string): Promise<VfsStat | null> {
    const normalized = normalizePath(path);
    this.write(normalized);
    const parent = await this.#inner.stat(dirname(normalized));
    if (parent.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent.path);
    try {
      return await this.#inner.stat(normalized);
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

  listPage(path: string, options?: PageOptions): EntryPage | Promise<EntryPage> {
    this.read(path);
    return this.#inner.listPage(path, options);
  }

  find(options: FindOptions) {
    this.read(options.path);
    return this.#inner.find(options);
  }

  findPage(options: FindOptions): EntryPage | Promise<EntryPage> {
    this.read(options.path);
    return this.#inner.findPage(options);
  }

  readFile(path: string): InlineReadResult | Promise<InlineReadResult> {
    this.read(path);
    return this.#inner.readFile(path);
  }

  writeFile(
    path: string,
    body: ByteBody,
    options?: WriteFileOptions,
  ): Promise<WriteResult> {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.writeFile(path, body, options);
  }

  appendFile(
    path: string,
    body: ByteBody,
    options?: AppendFileOptions,
  ): Promise<WriteResult> {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.appendFile(path, body, options);
  }

  touch(path: string, options?: TouchOptions): VfsStat | Promise<VfsStat> {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.touch(path, options);
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat | Promise<VfsStat> {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.setMetadata(path, options);
  }

  async mkdir(path: string, recursive?: boolean, mode?: number): Promise<VfsStat> {
    this.write(path);
    const mutations = await this.missingDirectoryCount(path, recursive === true);
    if (mutations > 0) this.#budget.mutation(mutations);
    return await this.#inner.mkdir(path, recursive, mode);
  }

  async remove(path: string, options?: RemoveOptions): Promise<RemoveResult> {
    this.write(path);
    const count = options?.recursive === true
      ? (await this.#inner.find({ path, includeRoot: true })).length
      : 1;
    this.#budget.mutation(Math.max(1, count));
    return await this.#inner.remove(path, options);
  }

  async move(from: string, to: string, options?: MoveOptions): Promise<MoveResult> {
    this.write(from);
    this.write(to);
    const count = (await this.#inner.find({ path: from, includeRoot: true })).length;
    this.#budget.mutation(Math.max(1, count));
    return await this.#inner.move(from, to, options);
  }

  async copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult> {
    this.read(from);
    this.write(to);
    const count = (await this.#inner.find({ path: from, includeRoot: true })).length;
    this.#budget.mutation(Math.max(1, count));
    return await this.#inner.copy(from, to, options);
  }

}
