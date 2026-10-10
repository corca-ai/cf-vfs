import { dirname } from "../../core/path.js";
import type { WriteFilesEntry } from "../../vfs/types.js";
import type { ShellCommandContext } from "../types.js";

/** One add batch: objects become durable before the engine publishes its index. */
export class GitObjectWrites {
  private readonly pending = new Map<string, WriteFilesEntry>();
  private held = 0;
  private failure: unknown;
  private flushing: Promise<void> | undefined;
  constructor(
    private readonly context: ShellCommandContext,
    private readonly prefix: string,
    private readonly capacity: number,
    private readonly release: () => void,
    private readonly mkdir: (path: string) => void,
  ) {}
  matches(path: string): boolean {
    return (
      path.startsWith(this.prefix) &&
      /^[a-f0-9]{2}\/[a-f0-9]{38}$/u.test(path.slice(this.prefix.length))
    );
  }
  async retain(path: string, body: Uint8Array, mode: number): Promise<boolean> {
    if (this.flushing !== undefined) await this.flushing;
    if (this.held + body.byteLength > this.capacity) return false;
    const previous = this.pending.get(path);
    this.held -= previous?.body instanceof Uint8Array ? previous.body.byteLength : 0;
    this.pending.set(path, mode === 0o100644 ? { path, body } : { path, body, mode });
    this.held += body.byteLength;
    return true;
  }
  async beforeRead(path: string): Promise<void> {
    if (this.pending.has(path) || this.flushing !== undefined) await this.flush();
  }
  async flush(): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (this.flushing !== undefined) return this.flushing;
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    this.held = 0;
    const work = this.commit(entries);
    this.flushing = work;
    try {
      await work;
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.flushing = undefined;
    }
  }
  private async commit(entries: WriteFilesEntry[]): Promise<void> {
    for (const path of new Set(entries.map((entry) => dirname(entry.path)))) this.mkdir(path);
    const writes = entries.map((entry) =>
      entry.mode === undefined || this.context.fileSystem.inspectWriteTarget(entry.path) === null
        ? entry
        : { path: entry.path, body: entry.body },
    );
    const write = this.context.fileSystem.writeFiles;
    if (write === undefined) throw new Error("Git object batch lost its writer");
    await write.call(this.context.fileSystem, writes);
  }
  close(): void {
    this.pending.clear();
    this.release();
  }
}
