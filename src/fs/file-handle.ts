import { VfsError } from "../core/errors.js";
import { bytes, position } from "./handle-utils.js";
import type { SqlFileHandles } from "./sql-file-handles.js";
import type { FsStats } from "./stats.js";

function writeBytes(
  body: string | Uint8Array,
  offset?: number | null,
  length?: number | string,
): Uint8Array {
  if (typeof body === "string") {
    if (typeof length === "string" && length !== "utf8" && length !== "utf-8")
      throw new VfsError("ENOTSUP", "unsupported encoding");
    return bytes(body);
  }
  const start = position(offset ?? 0);
  const count = typeof length === "number" ? position(length) : body.byteLength - start;
  if (start > body.byteLength || start + count > body.byteLength)
    throw new VfsError("EINVAL", "write exceeds buffer");
  return body.subarray(start, start + count);
}
/** A local descriptor references the inode, never a captured pathname or body. */
export class FsFileHandle {
  private cursor = 0;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly owner: SqlFileHandles,
    private readonly ino: number,
    readonly fd: number,
    private readonly readable: boolean,
    private readonly writable: boolean,
    private readonly append: boolean,
  ) {}
  private run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new VfsError("EBADF", "file handle is closed"));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private readableHandle(): void {
    if (!this.readable) throw new VfsError("EBADF", "handle is not readable");
  }
  private writableHandle(): void {
    if (!this.writable) throw new VfsError("EBADF", "handle is not writable");
  }
  readFile(
    options?: "utf8" | "utf-8" | { encoding?: "utf8" | "utf-8" | null },
  ): Promise<string | Uint8Array> {
    return this.run(async () => {
      this.readableHandle();
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (
        encoding !== undefined &&
        encoding !== null &&
        encoding !== "utf8" &&
        encoding !== "utf-8"
      )
        throw new VfsError("ENOTSUP", "unsupported encoding");
      const result = await this.owner.readRemaining(this.ino, this.cursor);
      this.cursor += result.byteLength;
      return encoding ? new TextDecoder().decode(result) : result;
    });
  }
  write(
    body: string,
    at?: number | null,
    encoding?: "utf8" | "utf-8",
  ): Promise<{ bytesWritten: number; buffer: string }>;
  write(
    body: Uint8Array,
    offset?: number,
    length?: number,
    at?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  write(
    body: string | Uint8Array,
    offset?: number | null,
    length?: number | string,
    at?: number | null,
  ): Promise<{ bytesWritten: number; buffer: string | Uint8Array }> {
    return this.run(() => {
      this.writableHandle();
      const explicit = typeof body === "string" ? offset : at;
      const data = writeBytes(body, offset, length);
      const end = this.owner.write(
        this.ino,
        data,
        explicit == null ? this.cursor : position(explicit),
        this.append,
      );
      if (explicit == null) this.cursor = end;
      return { bytesWritten: data.byteLength, buffer: body };
    });
  }
  writeFile(body: string | Uint8Array): Promise<void> {
    return this.run(() => {
      this.writableHandle();
      this.cursor = this.owner.write(this.ino, bytes(body), this.cursor, this.append);
    });
  }
  read(
    buffer: Uint8Array,
    offset = 0,
    length = buffer.byteLength - offset,
    at: number | null = null,
  ) {
    return this.run(async () => {
      this.readableHandle();
      position(offset);
      position(length);
      if (offset + length > buffer.byteLength) throw new VfsError("EINVAL", "read exceeds buffer");
      const data = await this.owner.read(
        this.ino,
        at === null ? this.cursor : position(at),
        length,
      );
      buffer.set(data, offset);
      if (at === null) this.cursor += data.byteLength;
      return { bytesRead: data.byteLength, buffer };
    });
  }
  truncate(size = 0): Promise<void> {
    return this.run(() => {
      this.writableHandle();
      this.owner.truncate(this.ino, position(size));
    });
  }
  stat(): Promise<FsStats> {
    return this.run(() => this.owner.stat(this.ino));
  }
  /** Waits for previous writes and the backing storage durability barrier. */
  sync(): Promise<void> {
    return this.run(() => this.owner.sync());
  }
  datasync(): Promise<void> {
    return this.sync();
  }
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    const closing = this.queue.then(async () => {
      this.owner.release(this.ino);
      await this.owner.maintenance();
    });
    this.closing = closing;
    void closing.catch(() => {
      this.closing = undefined;
    });
    return closing;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
