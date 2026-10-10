import { VfsError } from "../../core/errors.js";
import type { WriteFilesEntry } from "../../vfs/types.js";
import type { ShellCommandContext } from "../types.js";

interface PendingWrite {
  entry: WriteFilesEntry;
  release: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Bounded worktree writes; resolved promises always refer to committed bytes. */
export class GitCheckoutWrites {
  private pending: PendingWrite[] = [];
  private bytes = 0;
  private scheduled = false;
  private chain = Promise.resolve();
  constructor(private readonly context: ShellCommandContext) {}

  write(path: string, body: Uint8Array, mode?: number): Promise<void> | undefined {
    if (this.context.fileSystem.canUseBulkOperation?.("write-target", path) !== true)
      return undefined;
    const backend = this.context.fileSystem.availableWriteBufferBytes ?? 0;
    const available = this.context.budget.remainingBufferedBytes?.() ?? 0;
    if (body.byteLength > 128 * 1024 || backend < 256 * 1024 || available < body.byteLength)
      return undefined;
    if (this.bytes + body.byteLength > 128 * 1024) this.flush();
    const release = this.context.budget.buffered(body.byteLength);
    const result = new Promise<void>((resolve, reject) => {
      this.pending.push({
        entry: mode === undefined ? { path, body } : { path, body, mode },
        release,
        resolve,
        reject,
      });
      this.bytes += body.byteLength;
    });
    if (this.pending.length === 32) this.flush();
    if (!this.scheduled) {
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        this.flush();
      }, 0);
    }
    return result;
  }

  private flush(): void {
    const pending = this.pending;
    if (pending.length === 0) return;
    this.pending = [];
    this.bytes = 0;
    this.chain = this.chain.then(async () => {
      try {
        if (this.context.signal.aborted)
          throw new VfsError("ECANCELED", "Git execution was cancelled");
        this.context.budget.step();
        await this.publish(pending);
      } catch (error) {
        for (const item of pending) item.reject(error);
      } finally {
        for (const item of pending) item.release();
      }
    });
  }
  private async publish(pending: PendingWrite[]): Promise<void> {
    const write = this.context.fileSystem.writeFiles;
    if (write === undefined) throw new VfsError("ENOTSUP", "batch writes are unavailable");
    const eligible = pending.filter(
      (item) =>
        this.context.fileSystem.canUseBulkOperation?.("write-target", item.entry.path) === true,
    );
    if (eligible.length > 0)
      await write.call(
        this.context.fileSystem,
        eligible.map((item) => item.entry),
      );
    for (const item of eligible) item.resolve();
    for (const item of pending) {
      if (eligible.includes(item)) continue;
      await this.context.fileSystem.writeFile(
        item.entry.path,
        item.entry.body,
        item.entry.mode === undefined ? undefined : { mode: item.entry.mode },
      );
      item.resolve();
    }
  }
}
