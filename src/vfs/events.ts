/** A configured storage limit that refused work. */
export type VfsQuotaLimit =
  | "maxInlineFileBytes"
  | "maxInlineLogicalBytes"
  | "maxEntries"
  | "maxInFlightBufferedBytes"
  | "databaseHeadroom";

/** A stage of the opaque upload state machine. */
export type VfsOpaqueUploadPhase = "begin" | "commit" | "abort" | "expire" | "reject";

/**
 * What a committed namespace change did, as an observer needs to tell it apart.
 *
 * `write` replaces the content of an entry that was already there and `create`
 * publishes one that was not, because those are different answers for a client
 * holding a view: one refetches, the other adds. `metadata` covers mode,
 * ownership, and timestamps, which change the token without changing bytes.
 */
export type VfsMutationOp = "create" | "write" | "remove" | "move" | "metadata";

/**
 * The range a set-based mutation covered.
 *
 * Recursive remove, move, and copy deliberately never materialize their
 * entries — that is what makes them cost a constant number of statements — so
 * the notification names the range rather than the paths in it. `to` is
 * present when the range was relocated, and because a move is a prefix rename
 * a consumer can recompute any path it holds from `root` and `to` alone.
 */
export interface VfsMutationSubtree {
  readonly root: string;
  readonly to?: string;
}

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
  /**
   * One committed namespace change, for a host maintaining a view of the
   * workspace — a file tree, an open document, a search index.
   *
   * Reported only after the transaction commits, so a rolled-back mutation is
   * never announced. One call can report several changes: creating parents
   * publishes each directory it had to make, because each is a change a
   * consumer's view has to reflect.
   *
   * `mutationToken` is the one now in force, which is also what lets a writer
   * recognize its own publication: `writeFile` returns the same token, so a
   * consumer needs no separate notion of who wrote. It is absent for a change
   * that publishes a range rather than a single path.
   *
   * Deliberately absent: a revision, a size, and a writer identity. None of
   * them changed what a consumer did with the event, and the first two are not
   * known where the token is published, so carrying them would cost a query
   * this event does not otherwise need.
   */
  | {
      readonly type: "vfs.mutation";
      readonly op: VfsMutationOp;
      readonly path: string;
      readonly mutationToken?: string;
      readonly subtree?: VfsMutationSubtree;
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
