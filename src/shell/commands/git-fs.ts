import { VfsError } from "../../core/errors.js";
import { encodeUtf8 } from "../../core/unicode.js";
import { FsStats } from "../../fs/stats.js";
import { NO_ENTRY_IDENTITY, type VfsStat } from "../../vfs/types.js";
import { fileBody } from "../content.js";
import type { ShellCommandContext } from "../types.js";
import { GitCheckoutWrites } from "./git-checkout-writes.js";
import { GitObjectWrites, isLooseGitObject } from "./git-object-writes.js";
import { gitStatReads } from "./git-stat-reads.js";
import { collectStream, commandPath, readFileBytes } from "./helpers.js";

interface ConfigRead {
  readonly value: string;
  readonly byteLength: number;
}

/** Git sees only the execution's scoped filesystem, never the host VFS. */
export class GitFileSystem {
  private failure: unknown;
  private workReads:
    | { limit: number; snapshots: Map<string, VfsStat>; stats: Map<string, VfsStat> }
    | undefined;
  private objectWrites: GitObjectWrites | undefined;
  private commitObjectPrefix: string | undefined;
  private checkoutWrites: { dir: string; gitdir: string; writer: GitCheckoutWrites } | undefined;
  private readonly objectDirectories = new Set<string>();
  private configPath: string | undefined;
  private pendingConfig: Promise<ConfigRead> | undefined;
  private statReads: ReturnType<typeof gitStatReads> | undefined;
  constructor(readonly context: ShellCommandContext) {}

  beginWorkReads(limit: number): void {
    this.workReads = { limit, snapshots: new Map(), stats: new Map() };
    const fileSystem = this.context.fileSystem;
    const read = fileSystem.statMany;
    if (read !== undefined)
      this.statReads = gitStatReads((paths) => read.call(fileSystem, paths, { follow: false }));
  }
  workReadSnapshot(path: string): VfsStat | undefined {
    return this.workReads?.snapshots.get(path);
  }
  workStatSnapshot(path: string): VfsStat | undefined {
    return this.workReads?.stats.get(path);
  }
  private async readBytes(path: string) {
    const resolved = commandPath(this.context, path);
    const read = this.context.fileSystem.readFile(resolved);
    const work = this.workReads;
    if (work !== undefined && (work.snapshots.size < work.limit || work.snapshots.has(resolved)))
      work.snapshots.set(resolved, read.stat);
    return collectStream(this.context, fileBody(read.stream));
  }

  /** Share only overlapping reads, never a completed configuration snapshot. */
  coalesceConfigReads(gitdir: string): void {
    this.configPath = `${gitdir}/config`;
  }

  beginObjectWrites(gitdir: string, inputBytes: number, files: number): void {
    const backend = this.context.fileSystem.availableWriteBufferBytes ?? 0;
    const capacity = Math.min(2 * inputBytes + 128 * files, backend - inputBytes);
    const available = this.context.budget.remainingBufferedBytes?.() ?? 0;
    if (
      files < 32 ||
      capacity <= 0 ||
      this.context.fileSystem.writeFiles === undefined ||
      available < capacity + inputBytes
    )
      return;
    this.startObjectWrites(`${gitdir}/objects/`, capacity);
  }

  /** Reserve lazily: reading the index and parent commit needs full headroom. */
  beginCommitWrites(gitdir: string): void {
    this.commitObjectPrefix = `${gitdir}/objects/`;
  }

  endCommitWrites(): void {
    this.endObjectWrites();
    this.commitObjectPrefix = undefined;
  }

  private retainCommitObjects(path: string): void {
    const prefix = this.commitObjectPrefix;
    if (prefix === undefined || this.objectWrites !== undefined || !isLooseGitObject(path, prefix))
      return;
    const capacity = Math.min(
      128 * 1024,
      this.context.fileSystem.availableWriteBufferBytes ?? 0,
      this.context.budget.remainingBufferedBytes?.() ?? 0,
    );
    if (capacity > 0 && this.context.fileSystem.writeFiles !== undefined)
      this.startObjectWrites(prefix, capacity);
  }

  private async flushCommitObjects(): Promise<void> {
    if (this.commitObjectPrefix === undefined || this.objectWrites === undefined) return;
    await this.objectWrites.flush();
    this.endObjectWrites();
  }

  private async retainObject(
    writer: GitObjectWrites,
    path: string,
    bytes: Uint8Array,
    mode: number,
  ) {
    if (writer.matches(path) && (await writer.retain(path, bytes, mode))) return true;
    await writer.flush();
    if (this.commitObjectPrefix !== undefined) this.endObjectWrites();
    return false;
  }

  private beforeObjectRead(path: string): Promise<void> | undefined {
    return this.commitObjectPrefix === undefined
      ? this.objectWrites?.beforeRead(path)
      : this.flushCommitObjects();
  }

  private startObjectWrites(prefix: string, capacity: number): void {
    const release = this.context.budget.buffered(capacity);
    this.objectWrites = new GitObjectWrites(this.context, prefix, capacity, release, (path) => {
      if (this.objectDirectories.has(path)) return;
      try {
        this.mkdir(path);
      } catch (error) {
        if (!(error instanceof VfsError)) throw error;
        if (error.code === "ENOENT") this.mkdir(path, true);
        else if (error.code !== "EEXIST") throw error;
      }
      this.objectDirectories.add(path);
    });
  }

  beginCheckoutWrites(dir: string, gitdir: string): void {
    if (
      this.context.fileSystem.writeFiles !== undefined &&
      this.context.fileSystem.canUseBulkOperation !== undefined
    )
      this.checkoutWrites = {
        dir: `${dir}/`,
        gitdir: `${gitdir}/`,
        writer: new GitCheckoutWrites(this.context),
      };
  }

  endCheckoutWrites(): void {
    this.checkoutWrites = undefined;
  }

  endObjectWrites(): void {
    this.objectWrites?.close();
    this.objectWrites = undefined;
  }

  private async loadConfig(path: string): Promise<ConfigRead> {
    const lease = await readFileBytes(this.context, path);
    try {
      return { value: new TextDecoder().decode(lease.value), byteLength: lease.value.byteLength };
    } finally {
      lease.release();
    }
  }

  private async readConfig(path: string): Promise<ConfigRead> {
    if (this.pendingConfig !== undefined) {
      const value = await this.pendingConfig;
      // Each logical reader still consumes its execution's read allowance.
      this.context.budget.read(value.byteLength);
      return value;
    }
    const pending = this.loadConfig(path);
    this.pendingConfig = pending;
    try {
      return await pending;
    } finally {
      this.pendingConfig = undefined;
    }
  }

  check(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.context.signal.aborted) throw new VfsError("ECANCELED", "Git execution was cancelled");
    this.context.budget.step();
  }

  private async operation<T>(run: () => T | Promise<T>): Promise<T> {
    try {
      this.check();
      return await run();
    } catch (error) {
      // Git probes missing names and mkdir's existing names. Other VFS failures
      // must remain fatal even if the engine treats a failed probe as absence.
      if (
        error instanceof VfsError &&
        !["ENOENT", "EEXIST", "ENOTDIR", "EISDIR"].includes(error.code)
      )
        this.failure = error;
      throw error;
    }
  }

  mkdir(path: string, recursive = false) {
    this.check();
    return this.context.fileSystem.mkdir(
      commandPath(this.context, path),
      recursive,
      0o40777 & ~this.context.session.umask,
    );
  }

  /** Keep the metadata already returned by a directory read for local transfers. */
  listEntries(path: string) {
    this.check();
    const entries = this.context.fileSystem.list(commandPath(this.context, path));
    this.context.budget.glob(entries.length);
    return entries.filter((entry) => entry.ino !== NO_ENTRY_IDENTITY);
  }

  private creationMode(path: string, mode: number): number | undefined {
    // Omitting mode preserves existing permissions and creates ordinary 0644 files.
    return mode === 0o100644 || this.context.fileSystem.inspectWriteTarget(path) !== null
      ? undefined
      : mode;
  }

  private checkoutWrite(path: string, bytes: Uint8Array, mode?: number): Promise<void> | undefined {
    const batch = this.checkoutWrites;
    if (batch === undefined || !path.startsWith(batch.dir) || path.startsWith(batch.gitdir))
      return undefined;
    return batch.writer.write(path, bytes, mode);
  }

  private fileStats(path: string, follow: boolean): FsStats | Promise<FsStats> {
    const resolved = commandPath(this.context, path);
    const read = () => {
      const entry = follow
        ? this.context.fileSystem.stat(resolved)
        : this.context.fileSystem.lstat(resolved);
      const work = this.workReads;
      if (work !== undefined && (work.stats.size < work.limit || work.stats.has(resolved)))
        work.stats.set(resolved, entry);
      return new FsStats(entry);
    };
    if (!follow && this.statReads !== undefined && this.objectWrites === undefined)
      return this.statReads(resolved).then((result) => {
        if ("error" in result)
          throw new VfsError(result.error.code, result.error.message, result.error.path);
        const work = this.workReads;
        if (work !== undefined && (work.stats.size < work.limit || work.stats.has(resolved)))
          work.stats.set(resolved, result.stat);
        return new FsStats(result.stat);
      });
    return this.objectWrites === undefined
      ? read()
      : this.objectWrites.beforeRead(resolved).then(read);
  }

  readonly promises = {
    readFile: (path: string, options?: string | { encoding?: string }) =>
      this.operation(async () => {
        // A read may be larger than the spare capacity observed at the last write.
        // Publish and release commit buffers before collecting any file body.
        if (this.objectWrites !== undefined)
          await this.beforeObjectRead(commandPath(this.context, path));
        const encoding = typeof options === "string" ? options : options?.encoding;
        if (path === this.configPath && (encoding === "utf8" || encoding === "utf-8"))
          return (await this.readConfig(path)).value;
        const lease = await this.readBytes(path);
        try {
          if (encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8")
            throw new VfsError("ENOTSUP", "Git supports only UTF-8 text encoding", path);
          return encoding === undefined ? lease.value : new TextDecoder().decode(lease.value);
        } finally {
          lease.release();
        }
      }),
    writeFile: (path: string, body: string | Uint8Array, options?: { mode?: number }) =>
      this.operation(async () => {
        const bytes = typeof body === "string" ? encodeUtf8(body) : body;
        this.context.budget.io(bytes.byteLength);
        const resolved = commandPath(this.context, path);
        const mode = (options?.mode ?? 0o100666) & ~this.context.session.umask;
        this.retainCommitObjects(resolved);
        if (
          this.objectWrites !== undefined &&
          (await this.retainObject(this.objectWrites, resolved, bytes, mode))
        )
          return;
        const creationMode = this.creationMode(resolved, mode);
        const pending = this.checkoutWrite(resolved, bytes, creationMode);
        if (pending !== undefined) return pending;
        const creation = creationMode === undefined ? undefined : { mode: creationMode };
        await this.context.fileSystem.writeFile(resolved, bytes, creation);
      }),
    stat: (path: string) => this.operation(() => this.fileStats(path, true)),
    lstat: (path: string) => this.operation(() => this.fileStats(path, false)),
    readdir: (path: string) =>
      this.operation(() => {
        const list = () => {
          const entries = this.context.fileSystem.list(commandPath(this.context, path));
          this.context.budget.glob(entries.length);
          // Synthetic shell devices/applets have no stored Git file bytes.
          return entries
            .filter((entry) => entry.ino !== NO_ENTRY_IDENTITY)
            .map((entry) => entry.name);
        };
        return this.commitObjectPrefix === undefined
          ? list()
          : this.flushCommitObjects().then(list);
      }),
    mkdir: (path: string) => this.operation(() => this.mkdir(path)),
    unlink: (path: string) =>
      this.operation(() => {
        const resolved = commandPath(this.context, path);
        if (this.context.fileSystem.lstat(resolved).kind === "directory")
          throw new VfsError("EISDIR", "cannot unlink a directory", resolved);
        return this.context.fileSystem.remove(resolved).then(() => undefined);
      }),
    rmdir: (path: string) =>
      this.operation(() => {
        const resolved = commandPath(this.context, path);
        if (this.context.fileSystem.lstat(resolved).kind !== "directory")
          throw new VfsError("ENOTDIR", "not a directory", resolved);
        return this.context.fileSystem.remove(resolved).then(() => undefined);
      }),
    readlink: (path: string) =>
      this.operation(() => this.context.fileSystem.readlink(commandPath(this.context, path))),
    symlink: (target: string, path: string) =>
      this.operation(() =>
        this.context.fileSystem.symlink(commandPath(this.context, path), target),
      ),
    chmod: (path: string, mode: number) =>
      this.operation(() =>
        this.context.fileSystem.setMetadata(commandPath(this.context, path), { mode }),
      ),
  };
}
