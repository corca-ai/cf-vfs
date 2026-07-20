import { describe, expect, it } from "vitest";
import { VfsError } from "../src/core/errors.js";
import { MemoryFileSystem } from "../src/vfs/memory.js";
import { putOpaque, readOpaque } from "../src/vfs/opaque.js";
import { readAllBytes, streamFromChunks } from "../src/vfs/streams.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import type { OpaqueObjectMetadata, OpaqueStore } from "../src/vfs/types.js";
import { runVfsConformance } from "./helpers/vfs-conformance.js";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...await readAllBytes(stream, 16 * 1024 * 1024)];
}

describe("byte-oriented MemoryFileSystem", () => {
  it("creates byte streams that support BYOB readers", async () => {
    const reader = streamFromChunks([Uint8Array.of(1, 2, 3)]).getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(3));
    expect(first.done).toBe(false);
    expect([...(first.value ?? new Uint8Array())]).toEqual([1, 2, 3]);
    await reader.cancel();
  });

  describe("shared VFS conformance", () => {
    runVfsConformance(() => new MemoryFileSystem());
  });

  it("stores arbitrary bytes and gives active readers a bounded snapshot", async () => {
    const fileSystem = new MemoryFileSystem({ chunkBytes: 2 });
    await fileSystem.writeFile("/data", new Uint8Array([0xff, 0, 1, 2, 3]));

    const snapshot = fileSystem.readFile("/data");
    await fileSystem.writeFile("/data", new Uint8Array([9]));

    expect(await bytes(snapshot.stream)).toEqual([0xff, 0, 1, 2, 3]);
    expect(await bytes(fileSystem.readFile("/data").stream)).toEqual([9]);
  });

  it("does not publish a streaming write until close and rejects a concurrent path change", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/file", "old");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("new"));
        await gate;
        controller.close();
      },
    });

    const writing = fileSystem.writeFile("/file", body);
    await Promise.resolve();
    expect(new TextDecoder().decode(await readAllBytes(
      fileSystem.readFile("/file").stream,
      16,
    ))).toBe("old");

    fileSystem.touch("/file");
    release?.();
    await expect(writing).rejects.toMatchObject({ code: "EREVISION", path: "/file" });
  });

  it("keeps materialized read snapshots in the shared in-flight byte budget", async () => {
    const fileSystem = new MemoryFileSystem({
      maxInlineFileBytes: 4,
      maxInFlightBufferedBytes: 4,
    });
    await fileSystem.writeFile("/file", "1234");
    const first = fileSystem.readFile("/file");
    expect(() => fileSystem.readFile("/file")).toThrowError(
      expect.objectContaining({ code: "ENOSPC" }),
    );
    await first.stream.cancel();
    expect(await bytes(fileSystem.readFile("/file").stream)).toEqual([49, 50, 51, 52]);
  });

  it("shares the in-flight budget across concurrent streaming writes", async () => {
    const fileSystem = new MemoryFileSystem({
      maxInlineFileBytes: 8,
      maxInFlightBufferedBytes: 4,
    });
    let closeFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { closeFirst = resolve; });
    const first = fileSystem.writeFile("/first", new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        await firstGate;
        controller.close();
      },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await expect(fileSystem.writeFile("/second", new Uint8Array([4, 5, 6])))
      .rejects.toMatchObject({ code: "ENOSPC" });
    closeFirst?.();
    await first;
  });

  it("discards a failed input stream without publishing partial bytes", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/file", "old");
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("new"));
        controller.error(new Error("source failed"));
      },
    });
    await expect(fileSystem.writeFile("/file", failed)).rejects.toThrow("source failed");
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/file").stream, 16)))
      .toBe("old");
  });

  it("enforces file, workspace, entry, and in-flight limits without partial mutation", async () => {
    const fileSystem = new MemoryFileSystem({
      maxInlineFileBytes: 4,
      maxInlineLogicalBytes: 6,
      maxEntries: 3,
      maxInFlightBufferedBytes: 4,
    });
    await fileSystem.writeFile("/a", "1234");
    await expect(fileSystem.writeFile("/a", "12345"))
      .rejects.toMatchObject({ code: "ENOSPC" });
    expect(await bytes(fileSystem.readFile("/a").stream)).toEqual([49, 50, 51, 52]);

    await fileSystem.writeFile("/b", "12");
    await expect(fileSystem.writeFile("/c", "x"))
      .rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("preflights recursive parent creation with the final entry quota", async () => {
    const fileSystem = new MemoryFileSystem({ maxEntries: 2 });

    await expect(fileSystem.writeFile("/parent/file", "x", { createParents: true }))
      .rejects.toMatchObject({ code: "ENOSPC" });
    expect(() => fileSystem.stat("/parent")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("reserves immutable opaque keys while a put is in flight", async () => {
    const store = new MemoryOpaqueStore();
    let finish: (() => void) | undefined;
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        finish = () => controller.close();
      },
    });

    const first = store.putIfAbsent("reserved", firstBody);
    await Promise.resolve();
    await expect(store.putIfAbsent("reserved", "second"))
      .rejects.toMatchObject({ code: "EEXIST", path: "reserved" });
    finish?.();
    await expect(first).resolves.toMatchObject({ key: "reserved", sizeBytes: 5 });
  });

  it("shares opaque objects without copying bodies and deletes only the last reference", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    const stat = await putOpaque(fileSystem, store, "/asset", new Uint8Array([1, 2, 3]));
    const lease = fileSystem.resolveOpaqueRead("/asset", 1);

    expect(stat).toMatchObject({ contentClass: "opaque", sizeBytes: 3 });
    expect(fileSystem.copy("/asset", "/copy")).toMatchObject({
      copied: 1,
      opaqueBodiesCopied: 0,
    });
    expect(fileSystem.remove("/asset").opaqueObjectsQueuedForDeletion).toBe(0);
    expect(store.has(lease.object.key)).toBe(true);
    expect(fileSystem.remove("/copy").opaqueObjectsQueuedForDeletion).toBe(1);
    await fileSystem.drainGarbage();
    expect(store.has(lease.object.key)).toBe(false);
  });

  it("rejects shell-style reads of opaque bodies but supports leased programmatic reads", async () => {
    let now = 100;
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store, now: () => now });
    await putOpaque(fileSystem, store, "/asset", "payload");

    expect(() => fileSystem.readFile("/asset")).toThrowError(
      expect.objectContaining({ code: "ENOTSUP", path: "/asset" }),
    );
    const read = await readOpaque(fileSystem, store, "/asset", undefined, 50);
    expect(new TextDecoder().decode(Uint8Array.from(await bytes(read.stream)))).toBe("payload");
    const key = fileSystem.resolveOpaqueRead("/asset", 50).object.key;
    fileSystem.remove("/asset");

    now = 149;
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
    expect(store.has(key)).toBe(true);
    now = 151;
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 1, remaining: 0 });
    expect(store.has(key)).toBe(false);
  });

  it("prevents an upload reserved for an absent path from surviving create/delete ABA", async () => {
    let now = 0;
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({
      opaqueStore: store,
      now: () => now,
      uploadSettlementGraceMs: 1,
    });
    const upload = fileSystem.beginOpaqueUpload("/future", { expiresInMs: 100 });
    await store.putIfAbsent(upload.objectKey, "opaque");

    await fileSystem.writeFile("/future", "temporary");
    fileSystem.remove("/future");

    await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
      code: "EREVISION",
      path: "/future",
    });
    now = 101;
    expect(await fileSystem.drainGarbage()).toMatchObject({ deleted: 1 });
  });

  it("makes successful opaque commit retries idempotent", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    const upload = fileSystem.beginOpaqueUpload("/asset");
    await store.putIfAbsent(upload.objectKey, "body");

    const first = await fileSystem.commitOpaqueUpload(upload.uploadId);
    const second = await fileSystem.commitOpaqueUpload(upload.uploadId);
    expect(second).toEqual(first);
  });

  it("expires committed upload receipts without removing the committed file", async () => {
    let now = 0;
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({
      opaqueStore: store,
      now: () => now,
      receiptRetentionMs: 1,
    });
    const upload = fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 100 });
    await store.putIfAbsent(upload.objectKey, "body");
    await fileSystem.commitOpaqueUpload(upload.uploadId);
    now = 2;

    await expect(fileSystem.commitOpaqueUpload(upload.uploadId))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(fileSystem.stat("/asset")).toMatchObject({ contentClass: "opaque", sizeBytes: 4 });
  });

  it("does not accept a client-asserted digest that the store did not verify", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    const upload = fileSystem.beginOpaqueUpload("/asset");
    await store.putIfAbsent(upload.objectKey, "body");

    await expect(fileSystem.commitOpaqueUpload(upload.uploadId, {
      verifiedSha256: "untrusted",
    })).rejects.toEqual(expect.objectContaining<Partial<VfsError>>({ code: "EINVAL" }));
  });

  it("serializes concurrent commits and loses an in-flight verification after abort", async () => {
    let now = 0;
    let releaseHead: (() => void) | undefined;
    let signalHead: (() => void) | undefined;
    const headStarted = new Promise<void>((resolve) => { signalHead = resolve; });
    const headGate = new Promise<void>((resolve) => { releaseHead = resolve; });
    const backing = new MemoryOpaqueStore();
    const store: OpaqueStore = {
      putIfAbsent: (...args) => backing.putIfAbsent(...args),
      async head(key): Promise<OpaqueObjectMetadata | null> {
        signalHead?.();
        await headGate;
        return backing.head(key);
      },
      getStream: (...args) => backing.getStream(...args),
      delete: (...args) => backing.delete(...args),
    };
    const fileSystem = new MemoryFileSystem({
      opaqueStore: store,
      now: () => now,
      uploadSettlementGraceMs: 1,
    });
    const upload = fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 100 });
    await store.putIfAbsent(upload.objectKey, "body");

    const firstCommit = fileSystem.commitOpaqueUpload(upload.uploadId);
    await headStarted;
    await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
      code: "EAGAIN",
    });
    fileSystem.abortOpaqueUpload(upload.uploadId);
    releaseHead?.();
    await expect(firstCommit).rejects.toMatchObject({ code: "EREVISION" });
    now = 101;
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 1, remaining: 0 });
  });

  it("recovers an expired verification lease and retries failed garbage deletion with backoff", async () => {
    let now = 0;
    let releaseHead: (() => void) | undefined;
    let signalHead: (() => void) | undefined;
    const headStarted = new Promise<void>((resolve) => { signalHead = resolve; });
    const headGate = new Promise<void>((resolve) => { releaseHead = resolve; });
    const backing = new MemoryOpaqueStore();
    let failDelete = true;
    const store: OpaqueStore = {
      putIfAbsent: (...args) => backing.putIfAbsent(...args),
      async head(key): Promise<OpaqueObjectMetadata | null> {
        signalHead?.();
        await headGate;
        return backing.head(key);
      },
      getStream: (...args) => backing.getStream(...args),
      delete: async (...args) => {
        if (failDelete) {
          failDelete = false;
          throw new Error("transient delete failure");
        }
        await backing.delete(...args);
      },
    };
    const fileSystem = new MemoryFileSystem({
      opaqueStore: store,
      now: () => now,
      uploadSettlementGraceMs: 1,
    });
    const upload = fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 60_000 });
    await store.putIfAbsent(upload.objectKey, "body");
    const committing = fileSystem.commitOpaqueUpload(upload.uploadId);
    await headStarted;

    now = 61_000;
    await expect(fileSystem.drainGarbage()).rejects.toThrow("transient delete failure");
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
    now = 63_000;
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 1, remaining: 0 });
    releaseHead?.();
    await expect(committing).rejects.toMatchObject({ code: "EREVISION" });
  });

  it("moves and replaces opaque names without copying object bodies", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    await putOpaque(fileSystem, store, "/source", "source");
    await putOpaque(fileSystem, store, "/destination", "destination");
    expect(store.operations.puts).toBe(2);

    expect(fileSystem.move("/source", "/destination", { replace: true })).toMatchObject({
      moved: 1,
      replaced: true,
    });
    expect(store.operations.puts).toBe(2);
    expect(await fileSystem.drainGarbage()).toMatchObject({ deleted: 1 });
    expect((await readOpaque(fileSystem, store, "/destination")).stat.sizeBytes).toBe(6);
  });

  it("queues every newly unreachable generation in one recursive removal", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    await putOpaque(fileSystem, store, "/tree/a", "a", { createParents: true });
    await putOpaque(fileSystem, store, "/tree/sub/b", "b", { createParents: true });

    expect(fileSystem.remove("/tree", { recursive: true })).toMatchObject({
      removed: 4,
      opaqueObjectsQueuedForDeletion: 2,
    });
    expect(await fileSystem.drainGarbage(100)).toEqual({ deleted: 2, remaining: 0 });
    expect(store.operations.deleteRequests).toBe(1);
    expect(store.operations.deletedKeys).toBe(2);
  });
});
