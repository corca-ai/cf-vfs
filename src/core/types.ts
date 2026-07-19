export type Awaitable<T> = T | Promise<T>;
export type EntryKind = "directory" | "file";
export type ContentKind = "binary" | "text";

export interface VfsStat {
  path: string;
  parentPath: string;
  name: string;
  kind: EntryKind;
  contentKind: ContentKind | null;
  sizeBytes: number;
  lineCount: number;
  mode: number;
  createdAtMs: number;
  modifiedAtMs: number;
  revision: number;
}

export interface FindOptions {
  path: string;
  includeRoot?: boolean;
  maxDepth?: number;
  name?: string;
  pathGlob?: string;
  type?: EntryKind;
  limit?: number;
}

export interface TextReadResult {
  stat: VfsStat;
  text: string;
  bytesRead: number;
}

export interface TextSliceOptions {
  bytes?: number;
  lines?: number;
}

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
}

export interface WriteResult {
  path: string;
  revision: number;
  sizeBytes: number;
  created: boolean;
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
}

export type BinaryRange =
  | { offset: number; length?: number; suffix?: never }
  | { offset?: number; length: number; suffix?: never }
  | { offset?: never; length?: never; suffix: number };

export interface BinaryReadResult {
  stat: VfsStat;
  bytes: ArrayBuffer;
}

export interface BinaryWriteResult extends WriteResult {
  objectKey: string;
}

export interface VirtualFileSystem {
  stat(path: string): Awaitable<VfsStat>;
  list(path: string): Awaitable<VfsStat[]>;
  find(options: FindOptions): Awaitable<VfsStat[]>;
  readText(path: string): Awaitable<TextReadResult>;
  readTextHead(path: string, options: TextSliceOptions): Awaitable<TextReadResult>;
  readTextTail(path: string, options: TextSliceOptions): Awaitable<TextReadResult>;
  searchText(options: TextSearchOptions): Awaitable<TextSearchResult>;
  writeText(path: string, text: string, options?: WriteTextOptions): Awaitable<WriteResult>;
  replaceText(options: ReplaceTextOptions): Awaitable<ReplaceTextResult>;
  mkdir(path: string, recursive?: boolean): Awaitable<VfsStat>;
  remove(path: string, options?: RemoveOptions): Awaitable<RemoveResult>;
  move(from: string, to: string): Awaitable<MoveResult>;
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
  delete(key: string): Promise<void>;
}
