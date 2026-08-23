import { VfsError } from "../core/errors.js";
import { matchesGlob } from "../core/glob.js";
import { normalizePath, pathRequiresDirectory } from "../core/path.js";
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
  OwnershipUpdateOptions,
  PageOptions,
  RemoveOptions,
  RemoveResult,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
  WriteFileOptions,
  WriteResult,
} from "../vfs/types.js";
import { NO_ENTRY_IDENTITY } from "../vfs/types.js";
import type { ShellFileDescriptors, ShellFileSystem, ShellSink } from "./types.js";

/**
 * The device paths this shell answers, and nothing else.
 *
 * A table rather than a device framework: these are the names ordinary scripts
 * actually reach for, and each one is a capability the descriptor layer
 * already has. `/dev/zero`, terminals, and the rest would each need a model —
 * an endless stream, a width, a mode — that this runtime has no way to make
 * true, so they stay absent and report `ENOENT` like any other path.
 */
const DEVICES = {
  "/dev/null": "null",
  "/dev/stdin": "stdin",
  "/dev/stdout": "stdout",
  "/dev/stderr": "stderr",
  "/dev/fd/0": "stdin",
  "/dev/fd/1": "stdout",
  "/dev/fd/2": "stderr",
} as const satisfies Readonly<Record<string, string>>;

export type ShellDevice = (typeof DEVICES)[keyof typeof DEVICES];

/** `S_IFCHR` with the `666` bits Linux gives `/dev/null`. */
const DEVICE_MODE = 0o020000 | 0o666;
const DEVICE_DIRECTORY_MODE = 0o040755;

/** `/dev` and `/dev/fd`, which exist so the paths under them have a parent. */
const DEVICE_DIRECTORIES: Readonly<Record<string, readonly string[]>> = {
  "/dev": ["fd", "null", "stderr", "stdin", "stdout"],
  "/dev/fd": ["0", "1", "2"],
};

/** The mode an applet path reports: a regular file anyone may execute. */
const APPLET_MODE = 0o100755;

export interface ReservedPathOptions {
  /**
   * Applet directories and the command names they resolve.
   *
   * Supplied rather than discovered, because which names a session may run is
   * a policy question the shell has already answered. Listing one that would
   * be refused would advertise a command that cannot run — the same mistake
   * discovery makes when it reads the registry instead of the resolution.
   */
  readonly applets?: {
    readonly directories: readonly string[];
    readonly names: readonly string[];
  };
}

/**
 * Names the device at a path, if the path is one.
 *
 * Matched exactly, against an already-normalized path. There is no lookup
 * behind this: a device is a name the shell knows, and the table is the whole
 * of it.
 */
export function shellDevice(path: string): ShellDevice | undefined {
  return Object.hasOwn(DEVICES, path) ? DEVICES[path as keyof typeof DEVICES] : undefined;
}

function deviceStat(path: string, device: ShellDevice): VfsStat {
  return {
    path,
    parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
    name: path.slice(path.lastIndexOf("/") + 1),
    ino: NO_ENTRY_IDENTITY,
    kind: "file",
    contentClass: "inline",
    sizeBytes: 0,
    mode: DEVICE_MODE,
    uid: 0,
    gid: 0,
    createdAtMs: 0,
    modifiedAtMs: 0,
    revision: 1,
    // Never a usable guard: a device has no state to reserve, and a token that
    // looked usable would invite a caller to guard on nothing.
    mutationToken: `vfs:device:${device}`,
  };
}

/**
 * What an applet path reports.
 *
 * A regular file anyone may execute, with no content: `test -x /bin/cat` is
 * true because running it is exactly what the path is for, and its size is
 * zero because there is no file behind it to have a size.
 */
function appletStat(path: string): VfsStat {
  return {
    ...directoryStat(path),
    kind: "file",
    contentClass: "inline",
    mode: APPLET_MODE,
  } as VfsStat;
}

function directoryStat(path: string): VfsStat {
  return {
    path,
    parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
    name: path.slice(path.lastIndexOf("/") + 1),
    ino: NO_ENTRY_IDENTITY,
    kind: "directory",
    contentClass: null,
    sizeBytes: 0,
    mode: DEVICE_DIRECTORY_MODE,
    uid: 0,
    gid: 0,
    createdAtMs: 0,
    modifiedAtMs: 0,
    revision: 1,
    mutationToken: "vfs:device:dev",
  };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** Reads a body to its end and drops it, so a producer sees its writes land. */
async function drain(body: ByteBody): Promise<void> {
  if (!(body instanceof ReadableStream)) return;
  const reader = body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
  }
}

/**
 * The filesystem view a shell sees, with the reserved paths answered in front.
 *
 * A decorator rather than a branch inside the policy wrapper, because the two
 * views must not be able to disagree. When only some operations knew about
 * devices, `cat /dev/null` read the device while `rm /dev/null` removed a real
 * entry of the same name, a write to that entry was silently discarded, and
 * `mkdir -p /dev/null` produced something `rmdir` could never remove. Here
 * every method that could reach `/dev` goes through one place.
 *
 * Two kinds of path are reserved, under one rule. `/dev` holds the devices.
 * `/bin` and `/usr/bin` hold the applets — they resolve commands without
 * namespace rows, and listing them is what makes `which cat` answering
 * `/bin/cat` and `ls /bin` showing it the same fact. Neither is a directory
 * anything can create entries in, and nothing in either can be created, moved,
 * or removed. Reads and writes are answered; everything that would change the
 * namespace is refused. That is the rule, and it is the same rule for every
 * method.
 */
export class ReservedPathFileSystem implements ShellFileSystem {
  readonly #inner: ShellFileSystem;
  /** Reserved directory to the names it holds, including implied parents. */
  readonly #directories: ReadonlyMap<string, readonly string[]>;
  /** Reserved paths that are applets rather than devices or directories. */
  readonly #applets: ReadonlySet<string>;

  constructor(inner: ShellFileSystem, options: ReservedPathOptions = {}) {
    this.#inner = inner;
    const directories = new Map<string, string[]>();
    const add = (parent: string, name: string): void => {
      const existing = directories.get(parent);
      if (existing === undefined) directories.set(parent, [name]);
      else if (!existing.includes(name)) existing.push(name);
    };
    for (const [path, names] of Object.entries(DEVICE_DIRECTORIES)) {
      directories.set(path, [...names]);
    }
    const applets = new Set<string>();
    for (const directory of options.applets?.directories ?? []) {
      // A nested applet directory implies its parents: `/usr/bin` cannot be
      // listable while `/usr` reports nothing.
      const segments = directory.split("/").filter((segment) => segment.length > 0);
      for (let depth = 0; depth < segments.length; depth += 1) {
        const parent = depth === 0 ? "/" : `/${segments.slice(0, depth).join("/")}`;
        add(parent, segments[depth] ?? "");
        if (!directories.has(parent) && parent !== "/") directories.set(parent, []);
      }
      directories.set(directory, [...(options.applets?.names ?? [])]);
      for (const name of options.applets?.names ?? []) applets.add(`${directory}/${name}`);
    }
    // The root's own children are implied, never stored: `/` is a real
    // directory and its rows come from the namespace.
    add("/", "dev");
    this.#rootNames = directories.get("/") ?? ["dev"];
    directories.delete("/");
    for (const names of directories.values()) names.sort();
    this.#directories = directories;
    this.#applets = applets;
  }

  /** Reserved names that are children of the root. */
  readonly #rootNames: readonly string[];

  inspectWriteTarget(path: string): VfsStat | null {
    const at = this.#statAt(path);
    if (at !== undefined) return at;
    // A new name under `/dev` is refused here rather than by the inner
    // filesystem, which would report the missing parent instead of the rule.
    this.#refuseMutation(path);
    return this.#inner.inspectWriteTarget(path);
  }

  assertReadable(path: string): void {
    if (this.#at(path) === undefined) this.#inner.assertReadable(path);
  }

  assertWritable(path: string): void {
    if (this.#at(path) === undefined) this.#inner.assertWritable(path);
  }

  /** The device or reserved directory a path names literally, if any. */
  #at(
    path: string,
  ): { path: string; device?: ShellDevice; applet?: true; directory?: true } | undefined {
    const normalized = normalizePath(path);
    const device = shellDevice(normalized);
    if (device !== undefined || this.#applets.has(normalized)) {
      // A trailing slash asserts a directory, and neither of these is one.
      if (pathRequiresDirectory(path)) {
        throw new VfsError("ENOTDIR", "not a directory", normalized);
      }
      return device === undefined
        ? { path: normalized, applet: true }
        : { path: normalized, device };
    }
    if (this.#directories.has(normalized)) return { path: normalized, directory: true };
    return undefined;
  }

  /**
   * The device a path reaches, following links.
   *
   * A link to `/dev/null` is a link to `/dev/null`: `ln -s /dev/null quiet`
   * then `echo x > quiet` has to discard, and `[ -e quiet ]` has to be true.
   * Only the operations that follow links ask this — `rm` and `mv` name the
   * link itself and use the literal check above.
   */
  #reached(
    path: string,
  ): { path: string; device?: ShellDevice; applet?: true; directory?: true } | undefined {
    const direct = this.#at(path);
    if (direct !== undefined) return direct;
    let resolved: string;
    try {
      resolved = this.#inner.realpath(path);
    } catch {
      // Unresolvable here is not this layer's error to report; the operation
      // below will say what is wrong with the path.
      return undefined;
    }
    return resolved === normalizePath(path) ? undefined : this.#at(resolved);
  }

  /** Refuses a namespace change anywhere in the reserved device paths. */
  #refuseMutation(path: string): void {
    const normalized = normalizePath(path);
    const root = this.#rootNames.find(
      (name) => normalized === `/${name}` || normalized.startsWith(`/${name}/`),
    );
    if (root === undefined) return;
    throw new VfsError("EACCES", `/${root} is reserved and cannot be changed`, normalized);
  }

  #statAt(path: string, follow = true): VfsStat | undefined {
    const at = follow ? this.#reached(path) : this.#at(path);
    if (at === undefined) return undefined;
    if (at.device !== undefined) return deviceStat(at.path, at.device);
    return at.applet === true ? appletStat(at.path) : directoryStat(at.path);
  }

  stat(path: string): VfsStat {
    return this.#statAt(path) ?? this.#inner.stat(path);
  }

  lstat(path: string): VfsStat {
    return this.#statAt(path, false) ?? this.#inner.lstat(path);
  }

  readlink(path: string): string {
    if (this.#at(path) !== undefined) {
      throw new VfsError("EINVAL", "not a symbolic link", normalizePath(path));
    }
    return this.#inner.readlink(path);
  }

  realpath(path: string, options?: { follow?: boolean }): string {
    // A device is already canonical, and answering here is what keeps a device
    // path from costing the lookup that resolving one would.
    const at = this.#at(path);
    return at === undefined ? this.#inner.realpath(path, options) : at.path;
  }

  getMutationToken(path: string, options?: MutationTokenOptions): string {
    const at = this.#statAt(path);
    return at === undefined ? this.#inner.getMutationToken(path, options) : at.mutationToken;
  }

  readFile(path: string): InlineReadResult {
    const at = this.#reached(path);
    if (at === undefined) return this.#inner.readFile(path);
    if (at.applet === true) {
      // The path exists and runs; it is not a file with bytes behind it.
      throw new VfsError("ENOTSUP", "an applet has no file content to read", at.path);
    }
    if (at.device === undefined) throw new VfsError("EISDIR", "is a directory", at.path);
    if (at.device !== "null") {
      // A descriptor has no file behind it to read back, and this layer does
      // not hold the execution's descriptors anyway. `< /dev/stdin` is where
      // that belongs, and it works.
      throw new VfsError("EINVAL", "device is not readable", at.path);
    }
    return {
      stat: deviceStat(at.path, at.device) as InlineReadResult["stat"],
      stream: emptyStream(),
    };
  }

  async writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    const discarded = await this.#discard(path, body);
    return discarded ?? (await this.#inner.writeFile(path, body, options));
  }

  async appendFile(
    path: string,
    body: ByteBody,
    options?: AppendFileOptions,
  ): Promise<WriteResult> {
    const discarded = await this.#discard(path, body);
    return discarded ?? (await this.#inner.appendFile(path, body, options));
  }

  /**
   * Drops a body written to `/dev/null`, or reports that this is not one.
   *
   * The stream is read to its end rather than ignored so a producer sees its
   * writes accepted and releases whatever it holds. Nothing is charged for the
   * discard itself: the bytes were already metered when they were produced, and
   * charging again would make `cmd > /dev/null` cost more than `cmd > file`.
   */
  async #discard(path: string, body: ByteBody): Promise<WriteResult | undefined> {
    const at = this.#reached(path);
    if (at === undefined) return undefined;
    if (at.device !== "null") {
      this.#refuseMutation(at.path);
      return undefined;
    }
    await drain(body);
    const stat = deviceStat(at.path, at.device);
    return {
      path: stat.path,
      revision: stat.revision,
      mutationToken: stat.mutationToken,
      sizeBytes: 0,
      created: false,
    };
  }

  list(path: string): VfsStat[] {
    const at = this.#at(path);
    if (at !== undefined) {
      if (at.device !== undefined) throw new VfsError("ENOTDIR", "not a directory", at.path);
      const names = this.#directories.get(at.path) ?? [];
      return names.map((name) => {
        const child = at.path === "/" ? `/${name}` : `${at.path}/${name}`;
        return this.#statAt(child) ?? directoryStat(child);
      });
    }
    const entries = this.#inner.list(path);
    if (normalizePath(path) !== "/") return entries;
    // The reserved children of the root hold no rows. Leaving them out here
    // while answering for them everywhere else is exactly the disagreement the
    // reservation exists to prevent: they would be directories you can enter,
    // stat, and read, but never see.
    return [...entries, ...this.#rootEntries()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  }

  /** The reserved directories that are children of the root. */
  #rootEntries(): VfsStat[] {
    return this.#rootNames.map((name) => directoryStat(`/${name}`));
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    const at = this.#at(path);
    if (at !== undefined) {
      return { entries: this.list(path), nextCursor: null, scanned: 0 };
    }
    const page = this.#inner.listPage(path, options);
    const cursor = options?.cursor ?? "";
    // The cursor is the last path returned and the order is by path, so each
    // synthetic entry belongs in exactly one page: the first that has not
    // already passed it. Injecting one anywhere else would return it twice or
    // not at all.
    if (normalizePath(path) !== "/") return page;
    const pending = this.#rootEntries().filter((entry) => entry.path > cursor);
    if (pending.length === 0) return page;
    const limit = options?.limit ?? page.entries.length + pending.length;
    const merged = [...page.entries, ...pending].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const kept = merged.slice(0, limit);
    // An entry pushed off the end is not lost: the cursor now points at the
    // last one kept, so the next page starts with it.
    const truncated = kept.length < merged.length;
    return {
      entries: kept,
      nextCursor: truncated ? (kept.at(-1)?.path ?? null) : page.nextCursor,
      scanned: page.scanned,
    };
  }

  find(options: FindOptions): VfsStat[] {
    if (this.#at(options.path) !== undefined) return this.#findHere(options);
    const entries = this.#inner.find(options);
    const roots = this.#reservedRootsFor(options);
    return roots.length === 0
      ? entries
      : [...entries, ...roots].sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        );
  }

  findPage(options: FindOptions): EntryPage {
    if (this.#at(options.path) !== undefined) {
      return { entries: this.#findHere(options), nextCursor: null, scanned: 0 };
    }
    const page = this.#inner.findPage(options);
    const cursor = options.cursor ?? "";
    const pending = this.#reservedRootsFor(options).filter((entry) => entry.path > cursor);
    if (pending.length === 0) return page;
    const limit = options.limit ?? page.entries.length + pending.length;
    const merged = [...page.entries, ...pending].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const kept = merged.slice(0, limit);
    return {
      entries: kept,
      nextCursor: kept.length < merged.length ? (kept.at(-1)?.path ?? null) : page.nextCursor,
      scanned: page.scanned,
    };
  }

  /**
   * The `/dev` entry a walk of the root should report, if this walk should.
   *
   * A traversal reports `/dev` itself, because `find / -maxdepth 1` and `ls /`
   * are the same question and must not answer differently. It does not report
   * what is inside: those are descriptor paths a recursive reader cannot open,
   * so `grep -r /` would collect errors rather than results. Naming `/dev`
   * directly still lists them.
   */
  #reservedRootsFor(options: FindOptions): VfsStat[] {
    if (normalizePath(options.path) !== "/") return [];
    if ((options.maxDepth ?? Number.POSITIVE_INFINITY) < 1) return [];
    if (options.type !== undefined && options.type !== "directory") return [];
    return this.#rootNames
      .filter((name) => options.name === undefined || matchesGlob(name, options.name))
      .filter((name) => options.pathGlob === undefined || matchesGlob(`/${name}`, options.pathGlob))
      .map((name) => directoryStat(`/${name}`));
  }

  #findHere(options: FindOptions): VfsStat[] {
    const at = this.#at(options.path);
    if (at === undefined) return [];
    const root = this.#statAt(at.path);
    const found = root === undefined ? [] : [root];
    if (at.device === undefined) {
      for (const child of this.list(at.path)) {
        found.push(child);
        if (child.kind === "directory") found.push(...this.list(child.path));
      }
    }
    const selected = options.includeRoot === true ? found : found.slice(1);
    return selected.filter(
      (entry) =>
        (options.type === undefined || entry.kind === options.type) &&
        (options.name === undefined || matchesGlob(entry.name, options.name)),
    );
  }

  countSubtree(path: string): number {
    const at = this.#at(path);
    if (at === undefined) return this.#inner.countSubtree(path);
    return at.device === undefined ? this.list(at.path).length + 1 : 1;
  }

  touch(path: string, options?: TouchOptions): VfsStat {
    this.#refuseMutation(path);
    return this.#inner.touch(path, options);
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    this.#refuseMutation(path);
    return this.#inner.setMetadata(path, options);
  }

  setOwnership(path: string, options: OwnershipUpdateOptions): VfsStat {
    this.#refuseMutation(path);
    return this.#inner.setOwnership(path, options);
  }

  mkdir(path: string, recursive?: boolean, mode?: number): VfsStat {
    this.#refuseMutation(path);
    return this.#inner.mkdir(path, recursive, mode);
  }

  symlink(path: string, target: string, options?: SymlinkOptions): VfsStat {
    this.#refuseMutation(path);
    return this.#inner.symlink(path, target, options);
  }

  async remove(path: string, options?: RemoveOptions): Promise<RemoveResult> {
    this.#refuseMutation(path);
    return this.#inner.remove(path, options);
  }

  async move(from: string, to: string, options?: MoveOptions): Promise<MoveResult> {
    this.#refuseMutation(from);
    this.#refuseMutation(to);
    return this.#inner.move(from, to, options);
  }

  async copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult> {
    // Copying *from* a device is a read, which `readFile` already answers;
    // copying onto one would change the namespace.
    this.#refuseMutation(to);
    if (this.#at(from) !== undefined) {
      throw new VfsError("EINVAL", "cannot copy a device", normalizePath(from));
    }
    return this.#inner.copy(from, to, options);
  }
}

/**
 * The stream a device is read from as a redirection source.
 *
 * `/dev/stdin` is this execution's input, which only the descriptor layer
 * holds — which is why it is answered here and refused as a file operand.
 */
export function deviceInput(
  device: ShellDevice,
  fds: ShellFileDescriptors,
  path: string,
): ReadableStream<Uint8Array> {
  if (device === "null") return emptyStream();
  if (device === "stdin") return fds[0];
  throw new VfsError("EINVAL", "device is not readable", path);
}

/**
 * A sink that discards everything written to it.
 *
 * Nothing is buffered, no chunk is retained, and nothing is charged: the bytes
 * were already metered when whatever produced them read or generated them, and
 * charging again would make `cmd > /dev/null` fail budgets that `cmd > file`
 * passes. `close` and `abort` do nothing because there is nothing to publish or
 * undo, which is also what makes it safe to hand the same sink to two
 * descriptors.
 */
function nullSink(): ShellSink {
  const sink: ShellSink = {
    async write(): Promise<void> {},
    async close(): Promise<void> {},
    async abort(): Promise<void> {},
    clone: () => sink,
  };
  return sink;
}

/**
 * The sink a device is written to as a redirection target.
 *
 * A descriptor alias is a duplicate taken through the same reference counting
 * `2>&1` uses: `> /dev/stderr` writes where standard error currently goes, and
 * releasing the duplicate does not close what it was duplicated from.
 */
/**
 * A duplicate that can release its own reference but never destroy the stream.
 *
 * `abort` on a shared sink tears down the underlying stream for every holder,
 * which is right for a file being abandoned and catastrophic for a duplicate:
 * a redirection that fails after `> /dev/stdout` was applied would abort the
 * execution's own standard output and discard everything already written to
 * it. `2>&1` avoids this by keeping its duplicate out of the aborted set; a
 * duplicate that closes instead of aborting is safe wherever it is held.
 */
function aliasSink(inner: ShellSink): ShellSink {
  return {
    write: (chunk) => inner.write(chunk),
    close: () => inner.close(),
    abort: () => inner.close(),
    clone: () => aliasSink(inner.clone()),
  };
}

export function deviceSink(
  device: ShellDevice,
  fds: ShellFileDescriptors,
  path: string,
): ShellSink {
  if (device === "null") return nullSink();
  if (device === "stdout") return aliasSink(fds[1].clone());
  if (device === "stderr") return aliasSink(fds[2].clone());
  throw new VfsError("EINVAL", "device is not writable", path);
}
