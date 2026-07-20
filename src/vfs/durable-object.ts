import { DurableObject } from "cloudflare:workers";
import {
  DurableObjectFileSystem,
  type DurableObjectFileSystemOptions,
} from "./do-sql.js";
import type {
  AppendFileOptions,
  BeginOpaqueUploadOptions,
  ByteBody,
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
  OpaqueFileStat,
  OpaqueReadLease,
  OpaqueUploadReservation,
  PageOptions,
  RemoveOptions,
  RemoveResult,
  TouchOptions,
  VfsStat,
  WriteFileOptions,
  WriteResult,
} from "./types.js";
import {
  rpcAppendOptions,
  rpcBeginUploadOptions,
  rpcByteBody,
  rpcCommitUploadOptions,
  rpcCopyOptions,
  rpcFindOptions,
  rpcMetadataOptions,
  rpcMoveOptions,
  rpcOptionalNonnegativeInteger,
  rpcOptionalPositiveInteger,
  rpcPageOptions,
  rpcRemoveOptions,
  rpcString,
  rpcTouchOptions,
  rpcWriteOptions,
} from "./rpc-validation.js";

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

  getMutationToken(path: string): string {
    return this.fileSystem.getMutationToken(rpcString(path, "path"));
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
