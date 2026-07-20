export type Awaitable<T> = T | Promise<T>;
export const ENTRY_KINDS = ["directory", "file"] as const;
export type EntryKind = typeof ENTRY_KINDS[number];
export const CONTENT_KINDS = ["binary", "text"] as const;
export type ContentKind = typeof CONTENT_KINDS[number];

export interface VfsStatMetadata {
  path: string;
  parentPath: string;
  name: string;
  sizeBytes: number;
  lineCount: number;
  mode: number;
  createdAtMs: number;
  modifiedAtMs: number;
  revision: number;
}

export interface DirectoryStat extends VfsStatMetadata {
  kind: "directory";
  contentKind: null;
}

export interface TextFileStat extends VfsStatMetadata {
  kind: "file";
  contentKind: "text";
}

export interface BinaryFileStat extends VfsStatMetadata {
  kind: "file";
  contentKind: "binary";
}

export type VfsStat = DirectoryStat | TextFileStat | BinaryFileStat;

export interface FindOptions {
  path: string;
  includeRoot?: boolean;
  maxDepth?: number;
  name?: string;
  pathGlob?: string;
  type?: EntryKind;
  limit?: number;
}

export interface PageOptions {
  cursor?: string;
  limit?: number;
}

export interface FindPageOptions extends Omit<FindOptions, "limit">, PageOptions {}

export interface EntryPage {
  entries: VfsStat[];
  nextCursor: string | null;
  scanned: number;
}

export interface TextReadResult {
  stat: TextFileStat;
  text: string;
  bytesRead: number;
}

export type TextSliceOptions =
  | { readonly bytes: number; readonly lines?: never }
  | { readonly bytes?: never; readonly lines?: number };

export interface TextSearchOptions {
  roots: string[];
  pattern: string;
  fixed?: boolean;
  ignoreCase?: boolean;
  include?: string;
  maxResults?: number;
}

export interface TextSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface TextSearchResult {
  matches: TextSearchMatch[];
  filesScanned: number;
  bytesScanned: number;
  truncated: boolean;
}

export interface WriteTextOptions {
  createParents?: boolean;
  ifRevision?: number;
  mode?: number;
  disposition?: WriteDisposition;
}

export const WRITE_DISPOSITIONS = ["create", "replace", "upsert"] as const;
export type WriteDisposition = typeof WRITE_DISPOSITIONS[number];

export interface WriteResult {
  path: string;
  revision: number;
  sizeBytes: number;
  created: boolean;
}

export interface AppendTextOptions {
  ifRevision?: number;
}

export interface MetadataUpdateOptions {
  ifRevision?: number;
  mode?: number;
  modifiedAtMs?: number;
}

export interface TouchOptions extends MetadataUpdateOptions {
  create?: boolean;
  createParents?: boolean;
}

export interface ReplaceTextOptions {
  path: string;
  pattern: string;
  replacement: string;
  fixed?: boolean;
  ignoreCase?: boolean;
  global?: boolean;
  ifRevision?: number;
}

export interface ReplaceTextResult extends WriteResult {
  replacements: number;
  changed: boolean;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface RemoveResult {
  removed: number;
  binaryObjectsQueuedForDeletion: number;
}

export interface MoveResult {
  from: string;
  to: string;
  moved: number;
  replaced: boolean;
}

export interface MoveOptions {
  replace?: boolean;
}

export type BinaryRange =
  | { readonly offset: number; readonly length?: number; readonly suffix?: never }
  | { readonly offset?: number; readonly length: number; readonly suffix?: never }
  | { readonly offset?: never; readonly length?: never; readonly suffix: number };

export interface BinaryReadResult {
  stat: BinaryFileStat;
  bytes: ArrayBuffer;
}

export interface BinaryStreamReadResult {
  stat: BinaryFileStat;
  stream: ReadableStream<Uint8Array>;
}

export interface BinaryWriteResult extends WriteResult {
  objectKey: string;
}

export interface BinaryWriteOptions {
  createParents?: boolean;
  mode?: number;
}

export interface VirtualFileSystem {
  stat(path: string): Awaitable<VfsStat>;
  list(path: string): Awaitable<VfsStat[]>;
  listPage(path: string, options?: PageOptions): Awaitable<EntryPage>;
  find(options: FindOptions): Awaitable<VfsStat[]>;
  findPage(options: FindPageOptions): Awaitable<EntryPage>;
  readText(path: string): Awaitable<TextReadResult>;
  readTextHead(path: string, options: TextSliceOptions): Awaitable<TextReadResult>;
  readTextTail(path: string, options: TextSliceOptions): Awaitable<TextReadResult>;
  searchText(options: TextSearchOptions): Awaitable<TextSearchResult>;
  writeText(path: string, text: string, options?: WriteTextOptions): Awaitable<WriteResult>;
  appendText(path: string, text: string, options?: AppendTextOptions): Awaitable<WriteResult>;
  replaceText(options: ReplaceTextOptions): Awaitable<ReplaceTextResult>;
  touch(path: string, options?: TouchOptions): Awaitable<VfsStat>;
  setMetadata(path: string, options: MetadataUpdateOptions): Awaitable<VfsStat>;
  mkdir(path: string, recursive?: boolean, mode?: number): Awaitable<VfsStat>;
  remove(path: string, options?: RemoveOptions): Awaitable<RemoveResult>;
  move(from: string, to: string, options?: MoveOptions): Awaitable<MoveResult>;
  readBinaryStream?(
    path: string,
    range?: BinaryRange,
  ): Awaitable<BinaryStreamReadResult>;
}

export interface RegexProgram {
  findLine(value: string): number;
  replace(value: string, replacement: string, global: boolean): {
    value: string;
    replacements: number;
  };
}

export interface RegexEngine {
  compile(pattern: string, ignoreCase: boolean): RegexProgram;
}

export interface BinaryStore {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  ): Promise<{ size: number }>;
  get(key: string, range?: BinaryRange): Promise<ArrayBuffer | null>;
  getStream?(
    key: string,
    range?: BinaryRange,
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}
