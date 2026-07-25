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
  PageOptions,
  RemoveOptions,
  RemoveResult,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
  WriteFileOptions,
  WriteResult,
} from "../vfs/types.js";
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

/** Whether a path is inside the reserved device namespace at all. */
function reserved(path: string): boolean {
  return path === "/dev" || path.startsWith("/dev/");
}

function deviceStat(path: string, device: ShellDevice): VfsStat {
  return {
    path,
    parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
    name: path.slice(path.lastIndexOf("/") + 1),
    kind: "file",
    contentClass: "inline",
    sizeBytes: 0,
    mode: DEVICE_MODE,
    createdAtMs: 0,
    modifiedAtMs: 0,
    revision: 1,
    // Never a usable guard: a device has no state to reserve, and a token that
    // looked usable would invite a caller to guard on nothing.
    mutationToken: `vfs:device:${device}`,
  };
}

function directoryStat(path: string): VfsStat {
  return {
    path,
    parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
    name: path.slice(path.lastIndexOf("/") + 1),
    kind: "directory",
    contentClass: null,
    sizeBytes: 0,
    mode: DEVICE_DIRECTORY_MODE,
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
 * The filesystem view a shell sees, with the device paths answered in front.
 *
 * A decorator rather than a branch inside the policy wrapper, because the two
 * views must not be able to disagree. When only some operations knew about
 * devices, `cat /dev/null` read the device while `rm /dev/null` removed a real
 * entry of the same name, a write to that entry was silently discarded, and
 * `mkdir -p /dev/null` produced something `rmdir` could never remove. Here
 * every method that could reach `/dev` goes through one place.
 *
 * The whole of `/dev` is reserved: it is not a directory anything can create
 * entries in, and the seven names in it cannot be created, moved, or removed.
 * Reads and writes are answered; everything that would change the namespace is
 * refused. That is the rule, and it is the same rule for every method.
 */
export class DeviceFileSystem implements ShellFileSystem {
  readonly #inner: ShellFileSystem;

  constructor(inner: ShellFileSystem) {
    this.#inner = inner;
  }

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
  #at(path: string): { path: string; device?: ShellDevice; directory?: true } | undefined {
    const normalized = normalizePath(path);
    const device = shellDevice(normalized);
    if (device !== undefined) {
      // A trailing slash asserts a directory, and a device is not one.
      if (pathRequiresDirectory(path)) {
        throw new VfsError("ENOTDIR", "not a directory", normalized);
      }
      return { path: normalized, device };
    }
    if (Object.hasOwn(DEVICE_DIRECTORIES, normalized)) return { path: normalized, directory: true };
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
  #reached(path: string): { path: string; device?: ShellDevice; directory?: true } | undefined {
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
    if (!reserved(normalized)) return;
    throw new VfsError("EACCES", "the device namespace cannot be changed", normalized);
  }

  #statAt(path: string, follow = true): VfsStat | undefined {
    const at = follow ? this.#reached(path) : this.#at(path);
    if (at === undefined) return undefined;
    return at.device === undefined ? directoryStat(at.path) : deviceStat(at.path, at.device);
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
    if (at === undefined) return this.#inner.list(path);
    if (at.device !== undefined) throw new VfsError("ENOTDIR", "not a directory", at.path);
    const names = DEVICE_DIRECTORIES[at.path] ?? [];
    return names.map((name) => {
      const child = at.path === "/" ? `/${name}` : `${at.path}/${name}`;
      return this.#statAt(child) ?? directoryStat(child);
    });
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    const at = this.#at(path);
    if (at === undefined) return this.#inner.listPage(path, options);
    return { entries: this.list(path), nextCursor: null, scanned: 0 };
  }

  find(options: FindOptions): VfsStat[] {
    return this.#at(options.path) === undefined
      ? this.#inner.find(options)
      : this.#findHere(options);
  }

  findPage(options: FindOptions): EntryPage {
    if (this.#at(options.path) === undefined) return this.#inner.findPage(options);
    return { entries: this.#findHere(options), nextCursor: null, scanned: 0 };
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
