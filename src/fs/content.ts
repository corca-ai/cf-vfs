import { isVfsError, VfsError } from "../core/errors.js";
import { utf8ByteLength } from "../core/unicode.js";
import { validatePositiveInteger } from "../vfs/config.js";
import { putOpaque } from "../vfs/opaque.js";
import { byteRangeBounds } from "../vfs/range.js";
import {
  type ByteBody,
  type ByteRange,
  MAX_INLINE_FILE_BYTES,
  type OpaqueFileStat,
  type OpaqueStore,
  type VirtualFileSystem,
  type WriteFileOptions,
  type WriteResult,
} from "../vfs/types.js";
import { leasedStream } from "./leased-stream.js";
import type { FsContent } from "./read.js";

export interface TieredFileContentOptions {
  /** Materialized bodies above this size use the supplied immutable store. */
  inlineBytes?: number;
  leaseMs?: number;
  now?: () => number;
}

function bodySize(body: ByteBody): number | undefined {
  if (typeof body === "string") return utf8ByteLength(body);
  return body instanceof ReadableStream ? undefined : body.byteLength;
}

/** Streaming content capability. Namespace, CAS, quotas and GC stay in VFS. */
export class TieredFileContent implements FsContent {
  private readonly inlineBytes: number;
  private readonly now: () => number;

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly store: OpaqueStore,
    private readonly options: TieredFileContentOptions = {},
  ) {
    this.inlineBytes = options.inlineBytes ?? MAX_INLINE_FILE_BYTES;
    validatePositiveInteger(this.inlineBytes, "inlineBytes");
    if (this.inlineBytes > MAX_INLINE_FILE_BYTES)
      throw new VfsError("EINVAL", "inline tier exceeds the VFS file limit");
    this.now = options.now ?? Date.now;
  }

  async open(path: string, range?: ByteRange) {
    try {
      return this.vfs.readFile(path, range === undefined ? {} : { range });
    } catch (error) {
      if (!isVfsError(error) || error.code !== "ENOTSUP") throw error;
    }
    const lease = this.vfs.resolveOpaqueRead(path, this.options.leaseMs);
    const selected = byteRangeBounds(range, lease.stat.sizeBytes, path);
    const body = await this.getBody(
      lease.object.key,
      path,
      selected.length === 0 ? undefined : range,
    );
    if (this.now() >= lease.leaseExpiresAtMs) {
      await body.cancel().catch(() => undefined);
      throw new VfsError("EIO", "opaque read lease expired", path);
    }
    if (selected.length === 0) {
      await body.cancel();
      return {
        stat: lease.stat,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      };
    }
    return {
      stat: lease.stat,
      stream: leasedStream(body, path, lease.leaseExpiresAtMs, selected.length, () => this.now()),
    };
  }

  private async getBody(
    key: string,
    path: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const body = await this.store.getStream(key, range);
      if (body === null) throw new VfsError("EIO", "opaque object is missing", path);
      return body;
    } catch (error) {
      if (isVfsError(error)) throw error;
      throw new VfsError("EIO", "opaque content could not be opened", path);
    }
  }

  async write(
    path: string,
    body: ByteBody,
    options: WriteFileOptions & { storage?: "inline" | "opaque" } = {},
  ): Promise<WriteResult | OpaqueFileStat> {
    const size = bodySize(body);
    const opaque =
      options.storage === "opaque" ||
      (options.storage !== "inline" && size !== undefined && size > this.inlineBytes);
    if (!opaque) return this.vfs.writeFile(path, body, options);
    const token = options.ifMutationToken ?? this.vfs.getMutationToken(path);
    this.assertDisposition(path, options.disposition);
    return putOpaque(this.vfs, this.store, path, body, {
      ifMutationToken: token,
      ...(options.createParents === undefined ? {} : { createParents: options.createParents }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(size === undefined ? {} : { expectedSizeBytes: size }),
    });
  }

  async append(path: string, body: string | Uint8Array): Promise<WriteResult | OpaqueFileStat> {
    try {
      return await this.vfs.appendFile(path, body);
    } catch (error) {
      if (!isVfsError(error) || error.code !== "ENOTSUP") throw error;
    }
    const suffix = typeof body === "string" ? new TextEncoder().encode(body) : body.slice();
    const token = this.vfs.getMutationToken(path);
    const opened = await this.open(path);
    if (opened.stat.contentClass !== "opaque") {
      await opened.stream.cancel();
      throw new VfsError("EREVISION", "file changed storage tier", path);
    }
    if (suffix.byteLength === 0) {
      await opened.stream.cancel();
      return opened.stat;
    }
    const reader = opened.stream.getReader();
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (!chunk.done) {
            controller.enqueue(chunk.value);
            return;
          }
          reader.releaseLock();
          ended = true;
          controller.enqueue(suffix);
          controller.close();
        } catch (error) {
          ended = true;
          await reader.cancel(error).catch(() => undefined);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (!ended) {
          ended = true;
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        }
      },
    });
    try {
      return await this.write(path, stream, {
        storage: "opaque",
        disposition: "replace",
        ifMutationToken: token,
      });
    } catch (error) {
      await stream.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  private assertDisposition(path: string, disposition: WriteFileOptions["disposition"]): void {
    let exists = false;
    try {
      const stat = this.vfs.stat(path);
      if (stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
      exists = true;
    } catch (error) {
      if (!isVfsError(error) || error.code !== "ENOENT") throw error;
    }
    if (disposition === "create" && exists) throw new VfsError("EEXIST", "file exists", path);
    if (disposition === "replace" && !exists) throw new VfsError("ENOENT", "file is absent", path);
  }
}
