import { VfsError } from "../core/errors.js";
import type { FsFileHandle } from "../fs/file-handle.js";
import type { InFlightByteBudget } from "./buffering.js";
import type { EntryRow, VfsSqlStorage } from "./sql-model.js";
import type { PosixAccessContext } from "./sql-posix.js";
import type { OpaqueStore, VfsStat } from "./types.js";

/** Internal port. Only the trusted SQL engine passes it to the installed factory. */
export interface SqlHandlePort {
  sql: VfsSqlStorage;
  batch(query: string): void;
  sourceEntry(path: string, access?: PosixAccessContext): EntryRow;
  linked(): void;
  budget: InFlightByteBudget;
  chunkBytes: number;
  maximum: number;
  store: OpaqueStore | undefined;
  transaction<T>(operation: () => T): T;
  now(): number;
  openEntry(
    path: string,
    read: boolean,
    write: boolean,
    create: boolean,
    exclusive: boolean,
    mode: number,
    access?: PosixAccessContext,
  ): EntryRow;
  retain(callback: (path: string, recursive: boolean, root: EntryRow) => number): void;
  capacity(delta: number, path: string): void;
  usage(delta: number): void;
  publish(entry: EntryRow): void;
  reclaimObject(id: number): void;
  sync(): Promise<void>;
  maintenance(): Promise<void>;
  stat(entry: EntryRow): VfsStat;
}
export interface HandleProvider {
  link(from: string, to: string, access?: PosixAccessContext): void;
  open(path: string, flags: string, mode: number, access?: PosixAccessContext): FsFileHandle;
}
type Factory = (port: SqlHandlePort) => HandleProvider;
let factory: Factory | undefined;
/** Called by the fs adapter when its optional open API is first used. */
export function installHandleFactory(value: Factory): void {
  factory ??= value;
}
export function createHandleProvider(port: SqlHandlePort): HandleProvider {
  if (factory === undefined)
    throw new VfsError("ENOTSUP", "load the promise filesystem adapter to use handles");
  return factory(port);
}
