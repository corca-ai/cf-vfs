import { VfsError } from "../core/errors.js";
import { normalizeFileSystemPath } from "../core/path.js";
import { InFlightByteBudget } from "../vfs/buffering.js";
import { validatePositiveInteger } from "../vfs/config.js";
import { installHandleFactory } from "../vfs/handle-port.js";
import {
  MAX_INLINE_FILE_BYTES,
  type VirtualFileSystem,
  type WriteFileOptions,
} from "../vfs/types.js";
import type { FsFileHandle } from "./file-handle.js";
import type { FsMetadataCache } from "./metadata.js";
import { type FsContent, materialize } from "./read.js";
import { SqlFileHandles } from "./sql-file-handles.js";
import { FsDirent, FsStats } from "./stats.js";

export interface FsAdapterOptions {
  cwd?: string;
  /** Must receive ALL committed mutations of this filesystem through onEvent. */
  metadataCache?: FsMetadataCache;
  /** Explicitly opts into a host-supplied content tier. */
  content?: FsContent;
  maxReadFileBytes?: number;
  maxInFlightReadBytes?: number;
}

type Encoding = "utf8" | "utf-8" | null;
type ReadOptions = Encoding | { encoding?: Encoding; flag?: "r" };
type WriteOptions =
  | Encoding
  | { encoding?: Encoding; flag?: "w" | "wx" | "a" | "ax"; mode?: number };

function encoding(options: ReadOptions | WriteOptions | undefined): Encoding {
  const value = typeof options === "string" ? options : (options?.encoding ?? null);
  if (value !== null && value !== "utf8" && value !== "utf-8") {
    throw new VfsError("ENOTSUP", "only UTF-8 text encoding is supported");
  }
  return value;
}

class FsPromises {
  private readonly maximum: number;
  private readonly budget: InFlightByteBudget;

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly options: FsAdapterOptions,
  ) {
    this.maximum = options.maxReadFileBytes ?? MAX_INLINE_FILE_BYTES;
    validatePositiveInteger(this.maximum, "maxReadFileBytes");
    this.budget = new InFlightByteBudget(options.maxInFlightReadBytes ?? 32 * 1024 * 1024);
  }

  private path(path: string): string {
    return normalizeFileSystemPath(path, this.options.cwd ?? "/");
  }

  async readFile(
    path: string,
    options: "utf8" | "utf-8" | { encoding: "utf8" | "utf-8"; flag?: "r" },
  ): Promise<string>;
  async readFile(
    path: string,
    options?: null | { encoding?: null; flag?: "r" },
  ): Promise<Uint8Array<ArrayBuffer>>;
  async readFile(path: string, options: ReadOptions): Promise<Uint8Array<ArrayBuffer> | string>;
  async readFile(path: string, options?: ReadOptions): Promise<Uint8Array<ArrayBuffer> | string> {
    const textEncoding = encoding(options);
    if (typeof options === "object" && options?.flag !== undefined && options.flag !== "r") {
      throw new VfsError("ENOTSUP", "unsupported read flag", path);
    }
    const resolved = this.path(path);
    const opened =
      this.options.content === undefined
        ? this.vfs.readFile(resolved)
        : await this.options.content.open(resolved);
    const bytes = await materialize(opened, this.maximum, this.budget);
    return textEncoding === null ? bytes : new TextDecoder().decode(bytes);
  }

  async writeFile(path: string, body: string | Uint8Array, options?: WriteOptions): Promise<void> {
    encoding(options);
    const resolved = this.path(path);
    const settings = typeof options === "object" ? options : undefined;
    const flag = settings?.flag ?? "w";
    if (!["w", "wx", "a", "ax"].includes(flag))
      throw new VfsError("ENOTSUP", "unsupported write flag", path);
    if (flag === "a" && (await this.append(resolved, body))) return;
    if (flag === "wx" || flag === "ax") this.assertAbsent(resolved);
    const mode = this.creationMode(resolved, settings?.mode);
    const write: WriteFileOptions = {
      disposition: flag === "wx" || flag === "ax" || flag === "a" ? "create" : "upsert",
      ...(mode === undefined ? {} : { mode }),
    };
    if (this.options.content === undefined) await this.vfs.writeFile(resolved, body, write);
    else await this.options.content.write(resolved, body, write);
  }

  private async append(path: string, body: string | Uint8Array): Promise<boolean> {
    try {
      if (this.options.content?.append === undefined) await this.vfs.appendFile(path, body);
      else await this.options.content.append(path, body);
      return true;
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private assertAbsent(path: string): void {
    try {
      this.vfs.lstat(path);
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return;
      throw error;
    }
    throw new VfsError("EEXIST", "file or link already exists", path);
  }

  private creationMode(path: string, mode: number | undefined): number | undefined {
    if (mode === undefined) return undefined;
    try {
      this.vfs.stat(path);
      return undefined;
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return 0o100000 | (mode & 0o7777);
      throw error;
    }
  }

  async open(path: string, flags = "r", mode = 0o666) {
    installHandleFactory((port) => new SqlFileHandles(port));
    if (!("openFileHandle" in this.vfs) || typeof this.vfs.openFileHandle !== "function")
      throw new VfsError("ENOTSUP", "filesystem does not support inode handles", path);
    const open = this.vfs.openFileHandle as (
      path: string,
      flags: string,
      mode: number,
    ) => FsFileHandle;
    return open.call(this.vfs, this.path(path), flags, mode);
  }

  async link(from: string, to: string): Promise<void> {
    installHandleFactory((port) => new SqlFileHandles(port));
    if (!("linkFile" in this.vfs) || typeof this.vfs.linkFile !== "function")
      throw new VfsError("ENOTSUP", "filesystem does not support hard links");
    const link = this.vfs.linkFile as (from: string, to: string) => void;
    link.call(this.vfs, this.path(from), this.path(to));
  }

  async truncate(path: string, size = 0): Promise<void> {
    const handle = await this.open(path, "r+");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }

  async stat(path: string): Promise<FsStats> {
    const resolved = this.path(path);
    return new FsStats(
      this.options.metadataCache?.stat(this.vfs, resolved, true) ?? this.vfs.stat(resolved),
    );
  }

  async lstat(path: string): Promise<FsStats> {
    const resolved = this.path(path);
    return new FsStats(
      this.options.metadataCache?.stat(this.vfs, resolved, false) ?? this.vfs.lstat(resolved),
    );
  }

  async readdir(path: string, options?: { withFileTypes?: false }): Promise<string[]>;
  async readdir(path: string, options: { withFileTypes: true }): Promise<FsDirent[]>;
  async readdir(
    path: string,
    options: { withFileTypes?: boolean } = {},
  ): Promise<string[] | FsDirent[]> {
    const resolved = this.path(path);
    const entries = this.options.metadataCache?.list(this.vfs, resolved) ?? this.vfs.list(resolved);
    return options.withFileTypes
      ? entries.map((entry) => new FsDirent(entry))
      : entries.map((entry) => entry.name);
  }

  async mkdir(
    path: string,
    options?: number | { recursive?: boolean; mode?: number },
  ): Promise<void> {
    const resolved = this.path(path);
    const recursive = typeof options === "object" && options.recursive === true;

    this.vfs.mkdir(resolved, recursive, typeof options === "object" ? options.mode : options);
  }

  async unlink(path: string): Promise<void> {
    const resolved = this.path(path);
    if (this.vfs.lstat(resolved).kind === "directory")
      throw new VfsError("EISDIR", "is a directory", resolved);
    await this.vfs.remove(resolved);
  }

  async rmdir(path: string): Promise<void> {
    const resolved = this.path(path);
    if (this.vfs.lstat(resolved).kind !== "directory")
      throw new VfsError("ENOTDIR", "not a directory", resolved);
    await this.vfs.remove(resolved);
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const resolved = this.path(path);
    try {
      if (options.recursive !== true && this.vfs.lstat(resolved).kind === "directory") {
        throw new VfsError("EISDIR", "recursive option is required for a directory", resolved);
      }
      await this.vfs.remove(resolved, { recursive: options.recursive ?? false });
    } catch (error) {
      if (!(options.force && error instanceof VfsError && error.code === "ENOENT")) throw error;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.vfs.move(this.path(from), this.path(to), { replace: true });
  }
  async chmod(path: string, mode: number): Promise<void> {
    const resolved = this.path(path);
    const current = this.vfs.stat(resolved);
    this.vfs.setMetadata(resolved, { mode: (current.mode & ~0o7777) | (mode & 0o7777) });
  }
  async readlink(path: string): Promise<string> {
    return this.vfs.readlink(this.path(path));
  }
  async symlink(target: string, path: string): Promise<void> {
    this.vfs.symlink(this.path(path), target);
  }
}

/** A bounded fs.promises subset, independent of Node, shell and R2 imports. */
export function createFsAdapter(fileSystem: VirtualFileSystem, options: FsAdapterOptions = {}) {
  const fs = new FsPromises(fileSystem, options);
  return {
    promises: {
      open: fs.open.bind(fs),
      link: fs.link.bind(fs),
      truncate: fs.truncate.bind(fs),
      readFile: fs.readFile.bind(fs),
      writeFile: fs.writeFile.bind(fs),
      stat: fs.stat.bind(fs),
      lstat: fs.lstat.bind(fs),
      readdir: fs.readdir.bind(fs),
      mkdir: fs.mkdir.bind(fs),
      unlink: fs.unlink.bind(fs),
      rmdir: fs.rmdir.bind(fs),
      rm: fs.rm.bind(fs),
      rename: fs.rename.bind(fs),
      chmod: fs.chmod.bind(fs),
      readlink: fs.readlink.bind(fs),
      symlink: fs.symlink.bind(fs),
    },
  };
}
