import { VfsError } from "../core/errors.js";
import { validatePositiveInteger } from "./config.js";
import { collectRechunkedBytes } from "./streams.js";
import type { ByteBody } from "./types.js";

export interface BufferedChunksLease {
  readonly chunks: Uint8Array[];
  release(): void;
}

export class InFlightByteBudget {
  private usedBytes = 0;

  constructor(private readonly maximumBytes: number) {
    validatePositiveInteger(maximumBytes, "maxInFlightBufferedBytes");
  }

  acquire(bytes: number): void {
    if (this.usedBytes + bytes > this.maximumBytes) {
      throw new VfsError("ENOSPC", "runtime in-flight byte budget exceeded");
    }
    this.usedBytes += bytes;
  }

  release(bytes: number): void {
    this.usedBytes -= bytes;
  }
}

export async function collectInlineBytes(
  body: ByteBody,
  maximumBytes: number,
  chunkBytes: number,
  budget: InFlightByteBudget,
): Promise<BufferedChunksLease> {
  let accounted = 0;
  try {
    const collected = await collectRechunkedBytes(
      body,
      maximumBytes,
      chunkBytes,
      (delta) => {
        budget.acquire(delta);
        accounted += delta;
      },
    );
    let released = false;
    return {
      chunks: collected.chunks,
      release: () => {
        if (released) return;
        released = true;
        budget.release(accounted);
      },
    };
  } catch (error) {
    budget.release(accounted);
    throw error;
  }
}
