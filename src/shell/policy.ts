import { VfsError } from "../core/errors.js";
import { dirname, isDescendant, normalizePath } from "../core/path.js";
import { bodyToStream } from "../vfs/streams.js";
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
  MutationTokenOptions,
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
import { deviceStat, type ShellDevice, shellDevice } from "./devices.js";
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
  /**
   * Checks one set of roots against both the written and the resolved path.
   *
   * Resolving costs a lookup, so it is skipped entirely when the session
   * declares no roots — there is nothing to be outside of, and that is the
   * common case. When roots do exist the resolved form is the one that
   * decides, because a link inside a root can name anything at all.
   */
  #check(
    path: string,
    roots: readonly string[] | undefined,
    detail: string,
    follow: boolean,
  ): void {
    if (roots === undefined) return;
    if (!allowed(path, roots) || !allowed(this.#resolved(path, follow), roots)) {
      throw new VfsError("EACCES", detail, normalizePath(path));
    }
  }

  /**
   * Checks an operation that acts on a link rather than through it.
   *
   * `lstat` and `readlink` answer questions about the link itself, so the
   * check is about where the link lives, not where it points — refusing them
   * would be inconsistent with `ls -l`, which shows the same target text for
   * every entry in a readable directory. Everything on the way to the link is
   * still resolved, so an escaping directory link cannot be used to reach one.
   */
  private readLink(path: string): void {
    this.#check(path, this.#policy.readRoots, "path is outside the readable roots", false);
  }

  private read(path: string): void {
    this.#check(path, this.#policy.readRoots, "path is outside the readable roots", true);
  }

  private write(path: string): void {
    this.#check(path, this.#policy.writeRoots, "path is outside the writable roots", true);
  }

  /** Checks an operation that names a link: `rm`, `mv`, and `cp -P`. */
  private writeLink(path: string): void {
    this.#check(path, this.#policy.writeRoots, "path is outside the writable roots", false);
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

  getMutationToken(path: string, options?: MutationTokenOptions) {
    const { readRoots, writeRoots } = this.#policy;
    if (readRoots !== undefined || writeRoots !== undefined) {
      const scoped = (candidate: string): boolean =>
        allowed(candidate, readRoots) || allowed(candidate, writeRoots);
      if (!scoped(path) || !scoped(this.#resolved(path, options?.follow !== false))) {
        throw new VfsError("EACCES", "path is outside the scoped roots", normalizePath(path));
      }
    }
    return this.#inner.getMutationToken(path, options);
  }

  lstat(path: string) {
    this.readLink(path);
    const device = this.#device(path);
    if (device !== undefined) return deviceStat(device.path, device.device);
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
    const device = this.#device(normalized);
    if (device !== undefined) return deviceStat(device.path, device.device);
    const parent = this.#inner.stat(dirname(normalized));
    if (parent.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent.path);
    try {
      return this.#inner.stat(normalized);
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Answers a device path, or reports that this is not one.
   *
   * The check happens after the policy check, never before: a device is
   * subject to the declared roots like any other path, so a session scoped to
   * `/work` does not silently gain `/dev`. Nothing below this reaches storage,
   * which is what keeps a device from costing a SQL statement.
   */
  #device(path: string): { device: ShellDevice; path: string } | undefined {
    const normalized = normalizePath(path);
    const device = shellDevice(normalized);
    return device === undefined ? undefined : { device, path: normalized };
  }

  stat(path: string) {
    this.read(path);
    const device = this.#device(path);
    if (device !== undefined) return deviceStat(device.path, device.device);
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
    const device = this.#device(path);
    if (device !== undefined) {
      if (device.device !== "null") {
        // `cat /dev/stdin` as an operand would need the execution's input,
        // which this layer does not hold. Redirection is where a descriptor
        // alias belongs, and `< /dev/stdin` is how to write it.
        throw new VfsError("EINVAL", "device is not readable as a file", device.path);
      }
      return {
        stat: deviceStat(device.path, device.device) as InlineReadResult["stat"],
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      };
    }
    return this.#inner.readFile(path);
  }

  writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    this.write(path);
    const discarded = this.#discard(path, body);
    if (discarded !== undefined) return discarded;
    this.#budget.mutation();
    return this.#inner.writeFile(path, body, options);
  }

  /**
   * Consumes and drops a body written to `/dev/null`.
   *
   * The stream is drained rather than ignored so a producer sees its writes
   * accepted and any lease it holds is released, and the bytes are charged to
   * the I/O budget so the discard is not a way to do unmetered work. No
   * mutation is charged, because nothing was mutated.
   */
  #discard(path: string, body: ByteBody): Promise<WriteResult> | undefined {
    const device = this.#device(path);
    if (device?.device !== "null") return undefined;
    const stat = deviceStat(device.path, device.device);
    return (async () => {
      const stream = bodyToStream(body);
      const reader = stream.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        this.#budget.io(next.value.byteLength);
      }
      return {
        path: stat.path,
        revision: stat.revision,
        mutationToken: stat.mutationToken,
        sizeBytes: 0,
        created: false,
      };
    })();
  }

  appendFile(path: string, body: ByteBody, options?: AppendFileOptions): Promise<WriteResult> {
    this.write(path);
    const discarded = this.#discard(path, body);
    if (discarded !== undefined) return discarded;
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
    // Names the link, so the check is about where the link lives. Checking
    // where it points would make a link out of the roots impossible to delete
    // once created, which is a dead end rather than a protection.
    this.writeLink(path);
    const count = options?.recursive === true ? this.#inner.countSubtree(path) : 1;
    this.#budget.mutation(Math.max(1, count));
    return this.#inner.remove(path, options);
  }

  move(from: string, to: string, options?: MoveOptions): Promise<MoveResult> {
    this.writeLink(from);
    this.writeLink(to);
    this.#budget.mutation(Math.max(1, this.#inner.countSubtree(from)));
    return this.#inner.move(from, to, options);
  }

  copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult> {
    // A copy that dereferences reads through the link, so it is checked
    // against what it reaches; one that copies the link only copies its text.
    if (options?.dereference === true) this.read(from);
    else this.readLink(from);
    this.writeLink(to);
    this.#budget.mutation(Math.max(1, this.#inner.countSubtree(from)));
    return this.#inner.copy(from, to, options);
  }
}
