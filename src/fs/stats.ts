import type { VfsStat } from "../vfs/types.js";

/** Node-shaped metadata with independent modification and change times. */
export class FsStats {
  readonly size: number;
  readonly mode: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly dev = 0;
  readonly nlink: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly revision: number;
  readonly mutationToken: string;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;

  constructor(
    private readonly entry: VfsStat,
    nlink = 1,
  ) {
    this.nlink = entry.nlink ?? nlink;
    this.size = entry.sizeBytes;
    this.mode = entry.mode;
    this.ino = entry.ino;
    this.uid = entry.uid;
    this.gid = entry.gid;
    this.mtimeMs = entry.modifiedAtMs;
    this.ctimeMs = entry.changedAtMs ?? entry.modifiedAtMs;
    this.birthtimeMs = entry.createdAtMs;
    this.revision = entry.revision;
    this.mutationToken = entry.mutationToken;
    this.mtime = new Date(this.mtimeMs);
    this.ctime = new Date(this.ctimeMs);
    this.birthtime = new Date(this.birthtimeMs);
  }

  isFile(): boolean {
    return this.entry.kind === "file";
  }
  isDirectory(): boolean {
    return this.entry.kind === "directory";
  }
  isSymbolicLink(): boolean {
    return this.entry.kind === "symlink";
  }
}

export class FsDirent {
  readonly name: string;
  constructor(private readonly entry: VfsStat) {
    this.name = entry.name;
  }
  isFile(): boolean {
    return this.entry.kind === "file";
  }
  isDirectory(): boolean {
    return this.entry.kind === "directory";
  }
  isSymbolicLink(): boolean {
    return this.entry.kind === "symlink";
  }
}
