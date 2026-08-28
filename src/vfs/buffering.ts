import { VfsError } from "../core/errors.js";
import { validatePositiveInteger } from "./config.js";
import { emitVfsEvent, type VfsEventSink } from "./events.js";
import { collectRechunkedBytes, rechunk } from "./streams.js";
import type { ByteBody } from "./types.js";

export interface BufferedChunksLease {
  readonly chunks: Uint8Array[];
  readonly sizeBytes: number;
  release(): void;
}

function leasedChunks(
  chunks: Uint8Array[],
  sizeBytes: number,
  budget: InFlightByteBudget,
  accounted: number,
): BufferedChunksLease {
  let released = false;
  return {
    chunks,
    sizeBytes,
    release: () => {
      if (released) return;
      released = true;
      budget.release(accounted);
    },
  };
}

export class InFlightByteBudget {
  private usedBytes = 0;

  constructor(
    private readonly maximumBytes: number,
    private readonly onEvent?: VfsEventSink,
  ) {
    validatePositiveInteger(maximumBytes, "maxInFlightBufferedBytes");
  }

  /**
   * Reserves `bytes`, or refuses in a way the caller can act on.
   *
   * `heldByCaller` is what this same call already holds, and it is the whole
   * difference between the two refusals. A call whose own demand fits the
   * budget and is refused anyway lost a race with concurrent work -- a read
   * snapshot, another batch -- and would succeed once that work finishes, so
   * it gets `EAGAIN`. A call demanding more than the budget can ever hold gets
   * `ENOSPC`, because retrying it is work with no outcome: it has to ask for
   * less. Reporting both as `ENOSPC` leaves a caller unable to tell "try again"
   * from "split the batch", which matters most exactly where a call holds
   * several bodies at once.
   *
   * Nothing waits here. A queue would deadlock rather than delay: the capacity
   * a waiter needs is held by work that may itself be waiting on this object's
   * single thread.
   */
  acquire(bytes: number, heldByCaller = 0): void {
    if (this.usedBytes + bytes > this.maximumBytes) {
      emitVfsEvent(this.onEvent, {
        type: "vfs.quota",
        limit: "maxInFlightBufferedBytes",
        requested: bytes,
        used: this.usedBytes,
        max: this.maximumBytes,
      });
      throw heldByCaller + bytes > this.maximumBytes
        ? new VfsError("ENOSPC", "request exceeds the whole runtime in-flight byte budget")
        : new VfsError("EAGAIN", "runtime in-flight byte budget is temporarily exhausted");
    }
    this.usedBytes += bytes;
  }

  release(bytes: number): void {
    this.usedBytes -= bytes;
  }
}

/**
 * Collects a body into slabs, charged to the shared in-flight budget.
 *
 * `heldByCaller` is what the calling operation is holding for *other* bodies —
 * a batch collecting its second file has its first still materialized. Added
 * to what this body has taken so far, it is what lets the budget tell a batch
 * that is too large for it from one that merely arrived at a busy moment.
 */
export async function collectInlineBytes(
  body: ByteBody,
  maximumBytes: number,
  chunkBytes: number,
  budget: InFlightByteBudget,
  heldByCaller = 0,
): Promise<BufferedChunksLease> {
  let accounted = 0;
  try {
    const collected = await collectRechunkedBytes(body, maximumBytes, chunkBytes, (delta) => {
      budget.acquire(delta, heldByCaller + accounted);
      accounted += delta;
    });
    return leasedChunks(collected.chunks, collected.sizeBytes, budget, accounted);
  } catch (error) {
    budget.release(accounted);
    throw error;
  }
}

/** Takes the same bounded lease without introducing an async boundary for materialized input. */
export function collectInlineBytesSync(
  body: string,
  maximumBytes: number,
  chunkBytes: number,
  budget: InFlightByteBudget,
  heldByCaller = 0,
): BufferedChunksLease {
  const input = new TextEncoder().encode(body);
  const sizeBytes = input.byteLength;
  budget.acquire(sizeBytes, heldByCaller);
  if (sizeBytes > maximumBytes) {
    budget.release(sizeBytes);
    throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
  }
  const chunks =
    sizeBytes === 0 ? [] : sizeBytes <= chunkBytes ? [input.slice()] : rechunk([input], chunkBytes);
  return leasedChunks(chunks, sizeBytes, budget, sizeBytes);
}
