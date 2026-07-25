/** A configured storage limit that refused work. */
export type VfsQuotaLimit =
  | "maxInlineFileBytes"
  | "maxInlineLogicalBytes"
  | "maxEntries"
  | "maxInFlightBufferedBytes"
  | "databaseHeadroom";

/** A stage of the opaque upload state machine. */
export type VfsOpaqueUploadPhase = "begin" | "commit" | "abort" | "expire" | "reject";

export type VfsEvent =
  /**
   * A storage limit refused work. Always paired with a thrown `VfsError`.
   * `requested` is omitted when the refusal aborts a stream before its total
   * size is known.
   */
  | {
      readonly type: "vfs.quota";
      readonly limit: VfsQuotaLimit;
      readonly requested?: number;
      readonly used: number;
      readonly max: number;
      readonly path?: string;
    }
  /** Workspace totals after a committed mutation. Use as a gauge. */
  | {
      readonly type: "vfs.usage";
      readonly inlineBytes: number;
      readonly entries: number;
    }
  /** An opaque upload session changed state. */
  | {
      readonly type: "vfs.opaque-upload";
      readonly phase: VfsOpaqueUploadPhase;
      readonly uploadId: string;
      readonly objectKey: string;
      readonly path?: string;
      readonly reason?: string;
    }
  /** One garbage-collection batch settled. `remaining` is the queue depth. */
  | {
      readonly type: "vfs.garbage";
      readonly deleted: number;
      readonly remaining: number;
      readonly failed: number;
    };

export type VfsEventSink = (event: VfsEvent) => void;

/**
 * Delivers `event` to `sink` without letting observability change behavior.
 *
 * A throwing sink must not roll back a transaction, fail a mutation, or mask a
 * `VfsError` the caller is about to receive, so the failure is discarded.
 */
export function emitVfsEvent(sink: VfsEventSink | undefined, event: VfsEvent): void {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    // An observer cannot influence the operation it observes.
  }
}
