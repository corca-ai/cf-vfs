export const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

export type ContentClass = "inline" | "opaque";
export type EntryKind = "directory" | "file";
export type WriteDisposition = "create" | "replace" | "upsert";

export interface StatBase {
  path: string;
  parentPath: string;
  name: string;
  sizeBytes: number;
  mode: number;
  createdAtMs: number;
  modifiedAtMs: number;
  revision: number;
  mutationToken: string;
}

export interface DirectoryStat extends StatBase {
  kind: "directory";
  contentClass: null;
}

export interface InlineFileStat extends StatBase {
  kind: "file";
  contentClass: "inline";
}

export interface OpaqueFileStat extends StatBase {
  kind: "file";
  contentClass: "opaque";
  contentType?: string;
  verifiedSha256?: string;
}

export type VfsStat = DirectoryStat | InlineFileStat | OpaqueFileStat;

export interface PageOptions {
  cursor?: string;
  limit?: number;
}

export interface FindOptions extends PageOptions {
  path: string;
  includeRoot?: boolean;
  maxDepth?: number;
  name?: string;
  pathGlob?: string;
  type?: EntryKind;
}

export interface EntryPage {
  entries: VfsStat[];
  nextCursor: string | null;
  scanned: number;
}

export type ByteBody =
  | ReadableStream<Uint8Array>
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | string;

export interface InlineReadResult {
  stat: InlineFileStat;
  stream: ReadableStream<Uint8Array>;
}

export interface WriteFileOptions {
  createParents?: boolean;
  disposition?: WriteDisposition;
  ifRevision?: number;
  ifMutationToken?: string;
  mode?: number;
}

export interface AppendFileOptions {
  ifRevision?: number;
  ifMutationToken?: string;
}

export interface WriteResult {
  path: string;
  revision: number;
  mutationToken: string;
  sizeBytes: number;
  created: boolean;
}

export interface MetadataUpdateOptions {
  ifRevision?: number;
  ifMutationToken?: string;
  mode?: number;
  modifiedAtMs?: number;
}

export interface TouchOptions extends MetadataUpdateOptions {
  create?: boolean;
  createParents?: boolean;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface RemoveResult {
  removed: number;
  opaqueObjectsQueuedForDeletion: number;
}

export interface MoveOptions {
  replace?: boolean;
}

export interface MoveResult {
  from: string;
  to: string;
  moved: number;
  replaced: boolean;
}

export interface CopyOptions {
  replace?: boolean;
  recursive?: boolean;
  createParents?: boolean;
}

export interface CopyResult {
  from: string;
  to: string;
  copied: number;
  replaced: boolean;
  opaqueBodiesCopied: 0;
}

export type ByteRange =
  | { readonly offset: number; readonly length?: number; readonly suffix?: never }
  | { readonly offset?: number; readonly length: number; readonly suffix?: never }
  | { readonly offset?: never; readonly length?: never; readonly suffix: number };

export interface OpaqueObjectMetadata {
  key: string;
  sizeBytes: number;
  etag: string;
  version: string;
  contentType?: string;
  verifiedSha256?: string;
}

export interface OpaqueStore {
  putIfAbsent(key: string, body: ByteBody, metadata?: { contentType?: string }): Promise<OpaqueObjectMetadata>;
  head(key: string): Promise<OpaqueObjectMetadata | null>;
  getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  delete(keys: string | readonly string[]): Promise<void>;
}

export interface BeginOpaqueUploadOptions {
  createParents?: boolean;
  ifMutationToken?: string;
  mode?: number;
  expectedSizeBytes?: number;
  expiresInMs?: number;
  contentType?: string;
}

export interface OpaqueUploadReservation {
  uploadId: string;
  path: string;
  objectKey: string;
  expectedMutationToken: string;
  expiresAtMs: number;
  contentType?: string;
}

export interface CommitOpaqueUploadOptions {
  verifiedSha256?: string;
}

export interface OpaqueReadLease {
  stat: OpaqueFileStat;
  object: OpaqueObjectMetadata;
  leaseExpiresAtMs: number;
}

export interface GarbageDrainResult {
  deleted: number;
  remaining: number;
}

export interface VirtualFileSystem {
  getMutationToken(path: string): string;
  stat(path: string): VfsStat;
  list(path: string): VfsStat[];
  listPage(path: string, options?: PageOptions): EntryPage;
  find(options: FindOptions): VfsStat[];
  findPage(options: FindOptions): EntryPage;
  readFile(path: string): InlineReadResult;
  writeFile(path: string, body: ByteBody, options?: WriteFileOptions): Promise<WriteResult>;
  appendFile(path: string, body: ByteBody, options?: AppendFileOptions): Promise<WriteResult>;
  touch(path: string, options?: TouchOptions): VfsStat;
  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat;
  mkdir(path: string, recursive?: boolean, mode?: number): VfsStat;
  remove(path: string, options?: RemoveOptions): Promise<RemoveResult>;
  move(from: string, to: string, options?: MoveOptions): Promise<MoveResult>;
  copy(from: string, to: string, options?: CopyOptions): Promise<CopyResult>;
  beginOpaqueUpload(
    path: string,
    options?: BeginOpaqueUploadOptions,
  ): Promise<OpaqueUploadReservation>;
  commitOpaqueUpload(
    uploadId: string,
    options?: CommitOpaqueUploadOptions,
  ): Promise<OpaqueFileStat>;
  abortOpaqueUpload(uploadId: string): Promise<void>;
  resolveOpaqueRead(path: string, leaseMs?: number): OpaqueReadLease;
  drainGarbage(limit?: number): Promise<GarbageDrainResult>;
}
