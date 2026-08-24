import { DurableObject } from "cloudflare:workers";
import { DurableObjectFileSystem, type DurableObjectFileSystemOptions } from "./do-sql.js";
import {
  rpcAppendOptions,
  rpcBeginUploadOptions,
  rpcByteBody,
  rpcChangesSinceOptions,
  rpcCommitUploadOptions,
  rpcCopyOptions,
  rpcFindOptions,
  rpcFollowOptions,
  rpcIdentity,
  rpcMetadataOptions,
  rpcMoveOptions,
  rpcNonnegativeInteger,
  rpcOptionalNonnegativeInteger,
  rpcOptionalPositiveInteger,
  rpcOwnershipOptions,
  rpcPageOptions,
  rpcRemoveOptions,
  rpcString,
  rpcSymlinkOptions,
  rpcTouchOptions,
  rpcWriteOptions,
} from "./rpc-validation.js";
import type {
  AppendFileOptions,
  BeginOpaqueUploadOptions,
  ByteBody,
  ChangePage,
  ChangesSinceOptions,
  CommitOpaqueUploadOptions,
  CopyOptions,
  CopyResult,
  EntryPage,
  FindOptions,
  GarbageDrainResult,
  InlineReadResult,
  MetadataUpdateOptions,
  MoveOptions,
  MoveResult,
  MutationTokenOptions,
  OpaqueFileStat,
  OpaqueReadLease,
  OpaqueUploadReservation,
  OwnershipUpdateOptions,
  PageOptions,
  RemoveOptions,
  RemoveResult,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
  WriteFileOptions,
  WriteResult,
} from "./types.js";

export abstract class VfsDurableObject<Environment> extends DurableObject<Environment> {
  protected readonly fileSystem: DurableObjectFileSystem;

  protected constructor(
    ctx: DurableObjectState,
    env: Environment,
    options: DurableObjectFileSystemOptions = {},
  ) {
    super(ctx, env);
    this.fileSystem = new DurableObjectFileSystem(ctx.storage, options);
  }

  stat(path: string): VfsStat {
    return this.fileSystem.stat(rpcString(path, "path"));
  }

  statById(ino: number): VfsStat {
    return this.fileSystem.statById(rpcIdentity(ino));
  }

  lstat(path: string): VfsStat {
    return this.fileSystem.lstat(rpcString(path, "path"));
  }

  readlink(path: string): string {
    return this.fileSystem.readlink(rpcString(path, "path"));
  }

  symlink(path: string, target: string, options?: SymlinkOptions): VfsStat {
    return this.fileSystem.symlink(
      rpcString(path, "path"),
      rpcString(target, "target"),
      rpcSymlinkOptions(options),
    );
  }

  realpath(path: string, options?: { follow?: boolean }): string {
    return this.fileSystem.realpath(rpcString(path, "path"), rpcFollowOptions(options));
  }

  getMutationToken(path: string, options?: MutationTokenOptions): string {
    return this.fileSystem.getMutationToken(rpcString(path, "path"), rpcFollowOptions(options));
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    return this.fileSystem.listPage(rpcString(path, "path"), rpcPageOptions(options));
  }

  list(path: string): VfsStat[] {
    return this.fileSystem.list(rpcString(path, "path"));
  }

  findPage(options: FindOptions): EntryPage {
    return this.fileSystem.findPage(rpcFindOptions(options));
  }

  find(options: FindOptions): VfsStat[] {
    return this.fileSystem.find(rpcFindOptions(options));
  }

  countSubtree(path: string): number {
    return this.fileSystem.countSubtree(rpcString(path, "path"));
  }

  changesSince(since: number, options?: ChangesSinceOptions): ChangePage {
    return this.fileSystem.changesSince(
      rpcNonnegativeInteger(since, "since"),
      rpcChangesSinceOptions(options),
    );
  }

  readFile(path: string): InlineReadResult {
    return this.fileSystem.readFile(rpcString(path, "path"));
  }

  writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult> {
    return this.fileSystem.writeFile(
      rpcString(path, "path"),
      rpcByteBody(body),
      rpcWriteOptions(options),
    );
  }

  appendFile(path: string, body: ByteBody, options?: AppendFileOptions): Promise<WriteResult> {
    return this.fileSystem.appendFile(
      rpcString(path, "path"),
      rpcByteBody(body),
      rpcAppendOptions(options),
    );
  }

  touch(path: string, options?: TouchOptions): VfsStat {
    return this.fileSystem.touch(rpcString(path, "path"), rpcTouchOptions(options));
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    return this.fileSystem.setMetadata(rpcString(path, "path"), rpcMetadataOptions(options));
  }

  setOwnership(path: string, options: OwnershipUpdateOptions): VfsStat {
    return this.fileSystem.setOwnership(rpcString(path, "path"), rpcOwnershipOptions(options));
  }

  mkdir(path: string, recursive?: boolean, mode?: number): VfsStat {
    return this.fileSystem.mkdir(
      rpcString(path, "path"),
      recursive === undefined ? false : rpcRemoveOptions({ recursive })?.recursive,
      mode === undefined ? undefined : rpcOptionalNonnegativeInteger(mode, "mode"),
    );
  }

  remove(path: string, options?: RemoveOptions): Promise<RemoveResult> {
    return this.fileSystem.remove(rpcString(path, "path"), rpcRemoveOptions(options));
  }

  move(from: string, to: string, options?: MoveOptions): Promise<MoveResult> {
    return this.fileSystem.move(
      rpcString(from, "from"),
      rpcString(to, "to"),
      rpcMoveOptions(options),
    );
  }

  copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult> {
    return this.fileSystem.copy(
      rpcString(from, "from"),
      rpcString(to, "to"),
      rpcCopyOptions(options),
    );
  }

  beginOpaqueUpload(
    path: string,
    options?: BeginOpaqueUploadOptions,
  ): Promise<OpaqueUploadReservation> {
    return this.fileSystem.beginOpaqueUpload(
      rpcString(path, "path"),
      rpcBeginUploadOptions(options),
    );
  }

  commitOpaqueUpload(
    uploadId: string,
    options?: CommitOpaqueUploadOptions,
  ): Promise<OpaqueFileStat> {
    return this.fileSystem.commitOpaqueUpload(
      rpcString(uploadId, "uploadId"),
      rpcCommitUploadOptions(options),
    );
  }

  abortOpaqueUpload(uploadId: string): Promise<void> {
    return this.fileSystem.abortOpaqueUpload(rpcString(uploadId, "uploadId"));
  }

  resolveOpaqueRead(path: string, leaseMs?: number): OpaqueReadLease {
    return this.fileSystem.resolveOpaqueRead(
      rpcString(path, "path"),
      leaseMs === undefined ? undefined : rpcOptionalPositiveInteger(leaseMs, "leaseMs"),
    );
  }

  drainGarbage(limit?: number): Promise<GarbageDrainResult> {
    return this.fileSystem.drainGarbage(
      limit === undefined ? undefined : rpcOptionalPositiveInteger(limit, "limit"),
    );
  }

  override async alarm(): Promise<void> {
    await this.fileSystem.drainGarbage();
  }
}
