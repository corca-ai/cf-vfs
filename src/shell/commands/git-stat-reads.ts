import { VfsError } from "../../core/errors.js";
import type { StatManyResult } from "../../vfs/types.js";

/** Coalesce overlapping metadata reads, retaining no completed authorization. */
export function gitStatReads(read: (paths: readonly string[]) => StatManyResult[]) {
  let pending: Array<{
    path: string;
    resolve: (result: StatManyResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  const flush = () => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    try {
      const results = read(batch.map((entry) => entry.path));
      if (results.length !== batch.length) throw new VfsError("EIO", "incomplete metadata batch");
      for (const [index, entry] of batch.entries()) {
        const result = results[index];
        if (result === undefined) throw new VfsError("EIO", "incomplete metadata batch");
        entry.resolve(result);
      }
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    }
  };
  return (path: string) =>
    new Promise<StatManyResult>((resolve, reject) => {
      if (pending.length === 0) queueMicrotask(flush);
      pending.push({ path, resolve, reject });
      if (pending.length === 1000) flush();
    });
}
