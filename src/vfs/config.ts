import { VfsError } from "../core/errors.js";
import type { VfsEventSink } from "./events.js";
import { MAX_INLINE_FILE_BYTES, type OpaqueStore } from "./types.js";

export const DIRECTORY_MODE = 0o040755;
export const FILE_MODE = 0o100644;
/**
 * The mode a link carries: `S_IFLNK` with the `777` bits Linux gives every
 * link, because the permission that matters is the target's.
 */
export const SYMLINK_MODE = 0o120777;
export const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_VERIFY_LEASE_MS = 60_000;
const DEFAULT_UPLOAD_SETTLEMENT_GRACE_MS = 60_000;
const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_READ_LEASE_MS = 5 * 60 * 1000;
export const MAX_READ_LEASE_MS = 60 * 60 * 1000;
export const NEVER_MUTATED_TOKEN = "vfs:never-mutated";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_INLINE_LOGICAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;

export interface CommonFileSystemOptions {
  chunkBytes?: number;
  maxInlineFileBytes?: number;
  maxInlineLogicalBytes?: number;
  maxEntries?: number;
  maxInFlightBufferedBytes?: number;
  uploadSettlementGraceMs?: number;
  receiptRetentionMs?: number;
  opaqueStore?: OpaqueStore;
  now?: () => number;
  createId?: () => string;
  workspaceId?: string;
  /**
   * Observes quota, usage, opaque-upload, and garbage-collection events. Never
   * invoked when omitted — the filesystem also skips the usage query that would
   * feed it — and a throwing sink cannot roll back a mutation or mask an error.
   */
  onEvent?: VfsEventSink;
  /**
   * Stamps every path change with a workspace sequence, so a caller that was
   * away can ask what changed with `changesSince()`.
   *
   * Off by default because it writes one more column on every mutation path,
   * and the trusted path is required to cost exactly what it costs without any
   * optional feature. `onEvent` reports changes as they happen and is the right
   * tool for a caller that is present; this is for one that was not, and needs
   * to catch up without re-reading the namespace.
   */
  recordChanges?: boolean;
}

export interface ResolvedFileSystemLimits {
  readonly chunkBytes: number;
  readonly maxInlineFileBytes: number;
  readonly maxInlineLogicalBytes: number;
  readonly maxEntries: number;
  readonly maxInFlightBufferedBytes: number;
  readonly uploadSettlementGraceMs: number;
  readonly receiptRetentionMs: number;
}

export function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VfsError("EINVAL", `${name} must be a positive safe integer`);
  }
}

export function resolveFileSystemLimits(
  options: CommonFileSystemOptions,
): ResolvedFileSystemLimits {
  const limits: ResolvedFileSystemLimits = {
    chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    maxInlineFileBytes: options.maxInlineFileBytes ?? MAX_INLINE_FILE_BYTES,
    maxInlineLogicalBytes: options.maxInlineLogicalBytes ?? DEFAULT_MAX_INLINE_LOGICAL_BYTES,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxInFlightBufferedBytes: options.maxInFlightBufferedBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES,
    uploadSettlementGraceMs: options.uploadSettlementGraceMs ?? DEFAULT_UPLOAD_SETTLEMENT_GRACE_MS,
    receiptRetentionMs: options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS,
  };
  for (const [name, value] of Object.entries(limits)) validatePositiveInteger(value, name);
  if (limits.maxInlineFileBytes > MAX_INLINE_FILE_BYTES) {
    throw new VfsError("EINVAL", `maxInlineFileBytes cannot exceed ${MAX_INLINE_FILE_BYTES}`);
  }
  return limits;
}
