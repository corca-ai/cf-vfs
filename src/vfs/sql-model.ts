import { VfsError } from "../core/errors.js";
import type { BufferedChunksLease } from "./buffering.js";
import type { CommonFileSystemOptions } from "./config.js";
import type { VfsMutationOp, VfsMutationSubtree } from "./events.js";
import type {
  DirectoryStat,
  InlineFileStat,
  OpaqueFileStat,
  OpaqueObjectMetadata,
  SymlinkStat,
  VfsStat,
  WriteResult,
} from "./types.js";

export type VfsSqlRow = Readonly<Record<string, SqlStorageValue>>;
export type VfsSqlBinding = SqlStorageValue | Uint8Array;

export interface VfsSqlCursor<Row extends VfsSqlRow> {
  one(): Row;
  toArray(): Row[];
}

export interface VfsSqlStorage {
  readonly databaseSize: number;
  exec<Row extends VfsSqlRow>(query: string, ...bindings: VfsSqlBinding[]): VfsSqlCursor<Row>;
}

export interface SqlFileSystemStorage {
  readonly sql: VfsSqlStorage;
  execBatch?(query: string): void;
  transactionSync<Result>(callback: () => Result): Result;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export type SqlRow = VfsSqlRow;

interface EntryRowCommon {
  readonly id: number;
  readonly path: string;
  readonly parentPath: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly createdAtMs: number;
  readonly modifiedAtMs: number;
  readonly revision: number;
  readonly mutationVersion: number;
  readonly mutationToken: string;
}

export interface DirectoryEntryRow extends EntryRowCommon {
  readonly kind: "directory";
  readonly contentClass: null;
  readonly opaqueObjectId: null;
  readonly linkTarget: null;
}

export interface SymlinkEntryRow extends EntryRowCommon {
  readonly kind: "symlink";
  readonly contentClass: null;
  readonly opaqueObjectId: null;
  readonly linkTarget: string;
}

export interface InlineEntryRow extends EntryRowCommon {
  readonly kind: "file";
  readonly contentClass: "inline";
  readonly opaqueObjectId: null;
  readonly linkTarget: null;
}

export interface OpaqueEntryRow extends EntryRowCommon {
  readonly kind: "file";
  readonly contentClass: "opaque";
  readonly opaqueObjectId: number;
  readonly linkTarget: null;
}

export type EntryRow = DirectoryEntryRow | SymlinkEntryRow | InlineEntryRow | OpaqueEntryRow;

/** A committed namespace change, waiting for its transaction to commit. */
export interface PendingMutation {
  readonly op: VfsMutationOp;
  readonly path: string;
  readonly mutationToken?: string;
  readonly subtree?: VfsMutationSubtree;
}

export interface CreationParents {
  readonly existing: EntryRow;
  readonly missing: readonly string[];
}

/**
 * What a write decided before it started collecting bytes.
 *
 * Every decision here is made from SQLite in one synchronous pass, so a call
 * that is going to be refused is refused before it buffers anything -- and a
 * batch before it buffers the first of its bodies. `capturedToken` is taken
 * here and compared again inside the transaction, which is what makes "nothing
 * moved while the body streamed" a check rather than an assumption.
 */
export interface InlineWritePlan {
  /** The path as the caller wrote it, which is what a guard is checked against. */
  readonly written: string;
  readonly path: string;
  readonly followed: readonly string[];
  readonly createParents: boolean;
  readonly disposition: "upsert" | "create" | "replace";
  readonly skipIfUnchanged: boolean;
  readonly mode: number | undefined;
  readonly guard: { readonly ifMutationToken?: string };
  readonly capturedToken: string;
  readonly capturedEntry: EntryRow | null;
  /** A read snapshot whose version must still match in the publishing UPDATE. */
  readonly conditionalMutationVersion?: number;
}

export interface InlineWriteOutcome {
  readonly result: WriteResult;
  readonly queuedGarbage: boolean;
}

export interface PathState {
  readonly entry: EntryRow | null;
  readonly mutationToken: string;
}

export interface FindScanContext {
  readonly root: string;
  readonly rootEntry: EntryRow;
  readonly range: { lower: string; upper: string };
  readonly namePattern: RegExp | undefined;
  readonly pathPattern: RegExp | undefined;
}

/** One planned write and the bytes it is holding, ready to commit. */
export interface CollectedWrite {
  readonly plan: InlineWritePlan;
  readonly lease: BufferedChunksLease;
  readonly digest: string | undefined;
}

export interface OpaqueObjectRow {
  id: number;
  key: string;
  sizeBytes: number;
  etag: string;
  version: string;
  verifiedSha256: string | null;
  contentType: string | null;
  retainUntilMs: number;
}

export interface UploadRow {
  id: string;
  path: string;
  expectedMutationToken: string;
  objectKey: string;
  state: "open" | "verifying" | "committed" | "garbage";
  verificationToken: string | null;
  expectedSizeBytes: number | null;
  expiresAtMs: number;
  verificationLeaseUntilMs: number | null;
  createParents: boolean;
  mode: number | null;
  contentType: string | null;
  receiptJson: string | null;
}

export interface SqlFileSystemOptions extends CommonFileSystemOptions {
  maxDatabaseBytes?: number;
  minDatabaseHeadroomBytes?: number;
}

function invalidColumn(column: string, expected: string): never {
  throw new VfsError("EIO", `invalid SQLite row: ${column} must be ${expected}`);
}

export function stringColumn(row: SqlRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : invalidColumn(column, "text");
}

export function nullableStringColumn(row: SqlRow, column: string): string | null {
  const value = row[column];
  return value === null || typeof value === "string"
    ? value
    : invalidColumn(column, "text or null");
}

export function integerColumn(row: SqlRow, column: string): number {
  const value = row[column];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : invalidColumn(column, "a safe integer");
}

export function nullableIntegerColumn(row: SqlRow, column: string): number | null {
  const value = row[column];
  return value === null || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : invalidColumn(column, "a safe integer or null");
}

function invalidReceipt(path: string): never {
  throw new VfsError("EIO", "invalid committed upload receipt", path);
}

function isReceiptRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function receiptRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  return isReceiptRecord(value) ? value : invalidReceipt(path);
}

function receiptString(
  receipt: Readonly<Record<string, unknown>>,
  field: keyof OpaqueFileStat,
  path: string,
): string {
  const value = receipt[field];
  return typeof value === "string" ? value : invalidReceipt(path);
}

function optionalReceiptString(
  receipt: Readonly<Record<string, unknown>>,
  field: keyof OpaqueFileStat,
  path: string,
): string | undefined {
  const value = receipt[field];
  if (value === undefined || typeof value === "string") return value;
  return invalidReceipt(path);
}

function receiptInteger(
  receipt: Readonly<Record<string, unknown>>,
  field: keyof OpaqueFileStat,
  minimum: number,
  path: string,
): number {
  const value = receipt[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : invalidReceipt(path);
}

export function parseOpaqueReceipt(value: unknown, path: string): OpaqueFileStat {
  const receipt = receiptRecord(value, path);
  if (receipt["kind"] !== "file" || receipt["contentClass"] !== "opaque") {
    return invalidReceipt(path);
  }
  const contentType = optionalReceiptString(receipt, "contentType", path);
  const verifiedSha256 = optionalReceiptString(receipt, "verifiedSha256", path);
  return {
    kind: "file",
    contentClass: "opaque",
    path: receiptString(receipt, "path", path),
    parentPath: receiptString(receipt, "parentPath", path),
    name: receiptString(receipt, "name", path),
    ino: receiptInteger(receipt, "ino", 1, path),
    sizeBytes: receiptInteger(receipt, "sizeBytes", 0, path),
    mode: receiptInteger(receipt, "mode", 0, path),
    uid: receiptInteger(receipt, "uid", 0, path),
    gid: receiptInteger(receipt, "gid", 0, path),
    createdAtMs: receiptInteger(receipt, "createdAtMs", 0, path),
    modifiedAtMs: receiptInteger(receipt, "modifiedAtMs", 0, path),
    revision: receiptInteger(receipt, "revision", 1, path),
    mutationToken: receiptString(receipt, "mutationToken", path),
    ...(contentType === undefined ? {} : { contentType }),
    ...(verifiedSha256 === undefined ? {} : { verifiedSha256 }),
  };
}

export function blobColumn(row: SqlRow, column: string): ArrayBuffer {
  const value = row[column];
  return value instanceof ArrayBuffer ? value : invalidColumn(column, "a blob");
}

export function firstRow(cursor: VfsSqlCursor<SqlRow>): SqlRow | undefined {
  return cursor.toArray()[0];
}

export function formatMutationToken(epoch: string, version: number): string {
  return `${epoch}:${version}`;
}

export function parseEntry(row: SqlRow, mutationEpoch: string): EntryRow {
  const kind = stringColumn(row, "kind");
  const contentClass = nullableStringColumn(row, "content_class");
  const opaqueObjectId = nullableIntegerColumn(row, "opaque_object_id");
  const linkTarget = nullableStringColumn(row, "link_target");
  const path = stringColumn(row, "path");
  if (kind !== "directory" && kind !== "file" && kind !== "symlink") {
    invalidColumn("kind", "directory, file, or symlink");
  }
  if (contentClass !== null && contentClass !== "inline" && contentClass !== "opaque") {
    invalidColumn("content_class", "inline, opaque, or null");
  }
  const mutationVersion = integerColumn(row, "mutation_version");
  const common: EntryRowCommon = {
    id: integerColumn(row, "id"),
    path,
    parentPath: stringColumn(row, "parent_path"),
    name: stringColumn(row, "name"),
    sizeBytes: integerColumn(row, "size_bytes"),
    mode: integerColumn(row, "mode"),
    uid: integerColumn(row, "uid"),
    gid: integerColumn(row, "gid"),
    createdAtMs: integerColumn(row, "created_at_ms"),
    modifiedAtMs: integerColumn(row, "modified_at_ms"),
    revision: integerColumn(row, "revision"),
    mutationVersion,
    mutationToken: formatMutationToken(mutationEpoch, mutationVersion),
  };
  if (
    kind === "directory" &&
    contentClass === null &&
    opaqueObjectId === null &&
    linkTarget === null
  ) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  if (
    kind === "symlink" &&
    contentClass === null &&
    opaqueObjectId === null &&
    linkTarget !== null
  ) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  if (
    kind === "file" &&
    contentClass === "inline" &&
    opaqueObjectId === null &&
    linkTarget === null
  ) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  if (
    kind === "file" &&
    contentClass === "opaque" &&
    opaqueObjectId !== null &&
    linkTarget === null
  ) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  throw new VfsError("EIO", "invalid SQLite entry state", path);
}

export function rowToStat(row: DirectoryEntryRow): DirectoryStat;
export function rowToStat(row: SymlinkEntryRow): SymlinkStat;
export function rowToStat(row: InlineEntryRow): InlineFileStat;
export function rowToStat(row: OpaqueEntryRow): OpaqueFileStat;
export function rowToStat(row: EntryRow): VfsStat;
export function rowToStat(row: EntryRow): VfsStat {
  const common = {
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    // Already on the row every entry query reads, so reporting it costs no
    // column, no index, and no statement.
    ino: row.id,
    sizeBytes: row.sizeBytes,
    mode: row.mode,
    uid: row.uid,
    gid: row.gid,
    createdAtMs: row.createdAtMs,
    modifiedAtMs: row.modifiedAtMs,
    revision: row.revision,
    mutationToken: row.mutationToken,
  };
  if (row.kind === "directory") return { ...common, kind: "directory", contentClass: null };
  if (row.kind === "symlink") {
    return { ...common, kind: "symlink", contentClass: null, linkTarget: row.linkTarget };
  }
  if (row.contentClass === "inline") return { ...common, kind: "file", contentClass: "inline" };
  return { ...common, kind: "file", contentClass: "opaque" };
}

export function parseOpaqueObject(row: SqlRow): OpaqueObjectRow {
  return {
    id: integerColumn(row, "id"),
    key: stringColumn(row, "r2_key"),
    sizeBytes: integerColumn(row, "size_bytes"),
    etag: stringColumn(row, "etag"),
    version: stringColumn(row, "r2_version"),
    verifiedSha256: nullableStringColumn(row, "verified_sha256"),
    contentType: nullableStringColumn(row, "content_type"),
    retainUntilMs: integerColumn(row, "retain_until_ms"),
  };
}

export function parseUpload(row: SqlRow): UploadRow {
  const state = stringColumn(row, "state");
  if (state !== "open" && state !== "verifying" && state !== "committed" && state !== "garbage") {
    invalidColumn("state", "a valid upload state");
  }
  return {
    id: stringColumn(row, "id"),
    path: stringColumn(row, "path"),
    expectedMutationToken: stringColumn(row, "expected_mutation_token"),
    objectKey: stringColumn(row, "r2_key"),
    state,
    verificationToken: nullableStringColumn(row, "verification_token"),
    expectedSizeBytes: nullableIntegerColumn(row, "expected_size_bytes"),
    expiresAtMs: integerColumn(row, "expires_at_ms"),
    verificationLeaseUntilMs: nullableIntegerColumn(row, "verification_lease_until_ms"),
    createParents: integerColumn(row, "create_parents") === 1,
    mode: nullableIntegerColumn(row, "mode"),
    contentType: nullableStringColumn(row, "content_type"),
    receiptJson: nullableStringColumn(row, "receipt_json"),
  };
}

export function metadataFromObject(row: OpaqueObjectRow): OpaqueObjectMetadata {
  return {
    key: row.key,
    sizeBytes: row.sizeBytes,
    etag: row.etag,
    version: row.version,
    ...(row.contentType === null ? {} : { contentType: row.contentType }),
    ...(row.verifiedSha256 === null ? {} : { verifiedSha256: row.verifiedSha256 }),
  };
}
