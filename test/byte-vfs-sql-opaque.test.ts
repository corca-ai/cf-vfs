import { expect, it } from "vitest";
import type { VfsError } from "../src/core/errors.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import type { VfsEvent } from "../src/vfs/events.js";
import { putOpaque, readOpaque } from "../src/vfs/opaque.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type { OpaqueObjectMetadata, OpaqueStore } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...(await readAllBytes(stream, 16 * 1024 * 1024))];
}

it("weighs the workspace quota once over the set rather than once per entry", async () => {
  // As a sequence, the growing entry is weighed against a workspace that
  // has not yet been given back what the shrinking one is about to release.
  const sequential = createTestFileSystem({ maxInlineLogicalBytes: 120 });
  await sequential.writeFile("/big", "x".repeat(100));
  await expect(sequential.writeFile("/added", "y".repeat(50))).rejects.toMatchObject({
    code: "ENOSPC",
  });

  const batched = createTestFileSystem({ maxInlineLogicalBytes: 120 });
  await batched.writeFile("/big", "x".repeat(100));
  const written = await batched.writeFiles([
    { path: "/added", body: "y".repeat(50) },
    { path: "/big", body: "x" },
  ]);

  // The same two writes, as one set that ends at 51 bytes rather than as a
  // sequence that passes through 150.
  expect(written.map((result) => result.sizeBytes)).toEqual([50, 1]);
  expect(batched.stat("/big").sizeBytes).toBe(1);
  expect(batched.stat("/added").sizeBytes).toBe(50);
});

it("refuses a set that ends over the entry quota without creating any of it", async () => {
  const events: VfsEvent[] = [];
  const fileSystem = createTestFileSystem({
    maxEntries: 3,
    onEvent: (event) => events.push(event),
  });

  await expect(
    fileSystem.writeFiles([
      { path: "/a", body: "a" },
      { path: "/b", body: "b" },
      { path: "/c", body: "c" },
    ]),
  ).rejects.toMatchObject({ code: "ENOSPC" });

  // The set is what was refused, so the refusal reports what the set asked
  // for rather than whichever entry happened to cross the ceiling. Two of
  // these would have fitted, which is exactly the partial state a batch
  // exists to prevent.
  expect(events).toContainEqual({
    type: "vfs.quota",
    limit: "maxEntries",
    requested: 3,
    used: 1,
    max: 3,
  });
  expect(fileSystem.list("/")).toEqual([]);
  expect(events.filter((event) => event.type === "vfs.usage")).toHaveLength(0);
});

it("delivers one mutation per path once a set commits, and none when it rolls back", async () => {
  const mutations: Extract<VfsEvent, { type: "vfs.mutation" }>[] = [];
  const fileSystem = createTestFileSystem({
    maxInlineLogicalBytes: 8,
    onEvent: (event) => {
      if (event.type === "vfs.mutation") mutations.push(event);
    },
  });

  const written = await fileSystem.writeFiles([
    { path: "/one", body: "1" },
    { path: "/two", body: "2" },
  ]);
  expect(mutations).toEqual([
    {
      type: "vfs.mutation",
      op: "create",
      path: "/one",
      mutationToken: written[0]?.mutationToken,
    },
    {
      type: "vfs.mutation",
      op: "create",
      path: "/two",
      mutationToken: written[1]?.mutationToken,
    },
  ]);

  // Over the quota only once the whole set is counted, so both entries
  // reach SQLite before the refusal discards them. Nothing may be
  // announced for work a rollback took back.
  mutations.length = 0;
  await expect(
    fileSystem.writeFiles([
      { path: "/three", body: "xxx" },
      { path: "/four", body: "yyyy" },
    ]),
  ).rejects.toMatchObject({ code: "ENOSPC" });
  expect(mutations).toEqual([]);
  expect(fileSystem.list("/").map((entry) => entry.path)).toEqual(["/one", "/two"]);
});

it("separates a set too large to ever hold from one that arrived at a busy moment", async () => {
  const fileSystem = createTestFileSystem({
    maxInlineFileBytes: 4,
    maxInFlightBufferedBytes: 8,
  });
  await fileSystem.writeFile("/held", "1234");

  // Twelve bytes against a budget of eight. No amount of waiting makes
  // this set fit, so the caller has to split it rather than retry it.
  await expect(
    fileSystem.writeFiles([
      { path: "/a", body: "1111" },
      { path: "/b", body: "2222" },
      { path: "/c", body: "3333" },
    ]),
  ).rejects.toMatchObject({ code: "ENOSPC" });

  // The same eight bytes, which fit exactly -- but a read snapshot is
  // holding four of them. Identical demand, opposite advice.
  const snapshot = fileSystem.readFile("/held");
  await expect(
    fileSystem.writeFiles([
      { path: "/a", body: "1111" },
      { path: "/b", body: "2222" },
    ]),
  ).rejects.toMatchObject({ code: "EAGAIN" });
  expect(fileSystem.list("/").map((entry) => entry.path)).toEqual(["/held"]);

  await snapshot.stream.cancel();
  const written = await fileSystem.writeFiles([
    { path: "/a", body: "1111" },
    { path: "/b", body: "2222" },
  ]);
  expect(written.map((result) => result.path)).toEqual(["/a", "/b"]);
});

it("charges a set to the in-flight budget that already bounds one body", async () => {
  const events: VfsEvent[] = [];
  const fileSystem = createTestFileSystem({
    maxInlineFileBytes: 4,
    maxInFlightBufferedBytes: 6,
    onEvent: (event) => events.push(event),
  });

  // A set too large to materialize is refused by the limit that already
  // bounds how much a caller can hold at once, not by a second one.
  await expect(
    fileSystem.writeFiles([
      { path: "/a", body: "1234" },
      { path: "/b", body: "5678" },
    ]),
  ).rejects.toMatchObject({ code: "ENOSPC" });
  expect(events).toContainEqual({
    type: "vfs.quota",
    limit: "maxInFlightBufferedBytes",
    requested: 4,
    used: 4,
    max: 6,
  });
  expect(fileSystem.list("/")).toEqual([]);

  // The leases taken before the refusal are released there rather than
  // waiting for a transaction that never opens, so the budget is whole
  // again instead of permanently short by one failed batch.
  await fileSystem.writeFiles([{ path: "/a", body: "1234" }]);
  expect(await bytes(fileSystem.readFile("/a").stream)).toEqual([49, 50, 51, 52]);
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
  await expect(store.putIfAbsent("reserved", "second")).rejects.toMatchObject({
    code: "EEXIST",
    path: "reserved",
  });
  finish?.();
  await expect(first).resolves.toMatchObject({ key: "reserved", sizeBytes: 5 });
});

it("shares opaque objects without copying bodies and deletes only the last reference", async () => {
  // A read lease pushes the object's retention deadline into the future, and
  // GC only collects a key once that deadline has passed. Advance an injected
  // clock rather than assuming real time elapses between the two calls.
  let now = 1_000;
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store, now: () => now });
  const stat = await putOpaque(fileSystem, store, "/asset", new Uint8Array([1, 2, 3]));
  const lease = fileSystem.resolveOpaqueRead("/asset", 1);
  expect(lease.leaseExpiresAtMs).toBe(now + 1);

  expect(stat).toMatchObject({ contentClass: "opaque", sizeBytes: 3 });
  expect(await fileSystem.copy("/asset", "/copy")).toMatchObject({
    copied: 1,
    opaqueBodiesCopied: 0,
  });
  expect((await fileSystem.remove("/asset")).opaqueObjectsQueuedForDeletion).toBe(0);
  expect(store.has(lease.object.key)).toBe(true);
  expect((await fileSystem.remove("/copy")).opaqueObjectsQueuedForDeletion).toBe(1);

  // Still inside the lease: the name is gone but the body is retained.
  await fileSystem.drainGarbage();
  expect(store.has(lease.object.key)).toBe(true);

  now = lease.leaseExpiresAtMs;
  await fileSystem.drainGarbage();
  expect(store.has(lease.object.key)).toBe(false);
});

it("rejects shell-style reads of opaque bodies but supports leased programmatic reads", async () => {
  let now = 100;
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store, now: () => now });
  await putOpaque(fileSystem, store, "/asset", "payload");

  expect(() => fileSystem.readFile("/asset")).toThrowError(
    expect.objectContaining({ code: "ENOTSUP", path: "/asset" }),
  );
  const read = await readOpaque(fileSystem, store, "/asset", undefined, 50);
  expect(new TextDecoder().decode(Uint8Array.from(await bytes(read.stream)))).toBe("payload");
  const key = fileSystem.resolveOpaqueRead("/asset", 50).object.key;
  await fileSystem.remove("/asset");

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
  const fileSystem = createTestFileSystem({
    opaqueStore: store,
    now: () => now,
    uploadSettlementGraceMs: 1,
  });
  const upload = await fileSystem.beginOpaqueUpload("/future", { expiresInMs: 100 });
  await store.putIfAbsent(upload.objectKey, "opaque");

  await fileSystem.writeFile("/future", "temporary");
  await fileSystem.remove("/future");

  await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
    code: "EREVISION",
    path: "/future",
  });
  now = 101;
  expect(await fileSystem.drainGarbage()).toMatchObject({ deleted: 1 });
});

it("retries an opaque commit after a local precondition is repaired", async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  const upload = await fileSystem.beginOpaqueUpload("/parent/asset");
  await store.putIfAbsent(upload.objectKey, "body");

  await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
    code: "ENOENT",
  });
  fileSystem.mkdir("/parent");

  await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).resolves.toMatchObject({
    path: "/parent/asset",
    contentClass: "opaque",
  });
});

it("makes successful opaque commit retries idempotent", async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  const upload = await fileSystem.beginOpaqueUpload("/asset");
  await store.putIfAbsent(upload.objectKey, "body");

  const first = await fileSystem.commitOpaqueUpload(upload.uploadId);
  const second = await fileSystem.commitOpaqueUpload(upload.uploadId);
  expect(second).toEqual(first);
});

it("expires committed upload receipts without removing the committed file", async () => {
  let now = 0;
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({
    opaqueStore: store,
    now: () => now,
    receiptRetentionMs: 1,
  });
  const upload = await fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 100 });
  await store.putIfAbsent(upload.objectKey, "body");
  await fileSystem.commitOpaqueUpload(upload.uploadId);
  now = 2;

  await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(fileSystem.stat("/asset")).toMatchObject({ contentClass: "opaque", sizeBytes: 4 });
});

it("does not accept a client-asserted digest that the store did not verify", async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  const upload = await fileSystem.beginOpaqueUpload("/asset");
  await store.putIfAbsent(upload.objectKey, "body");

  await expect(
    fileSystem.commitOpaqueUpload(upload.uploadId, {
      verifiedSha256: "untrusted",
    }),
  ).rejects.toEqual(expect.objectContaining<Partial<VfsError>>({ code: "EINVAL" }));
});

it("serializes concurrent commits and loses an in-flight verification after abort", async () => {
  let now = 0;
  let releaseHead: (() => void) | undefined;
  let signalHead: (() => void) | undefined;
  const headStarted = new Promise<void>((resolve) => {
    signalHead = resolve;
  });
  const headGate = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
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
  const fileSystem = createTestFileSystem({
    opaqueStore: store,
    now: () => now,
    uploadSettlementGraceMs: 1,
  });
  const upload = await fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 100 });
  await store.putIfAbsent(upload.objectKey, "body");

  const firstCommit = fileSystem.commitOpaqueUpload(upload.uploadId);
  await headStarted;
  await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
    code: "EAGAIN",
  });
  await fileSystem.abortOpaqueUpload(upload.uploadId);
  releaseHead?.();
  await expect(firstCommit).rejects.toMatchObject({ code: "EREVISION" });
  now = 101;
  expect(await fileSystem.drainGarbage()).toEqual({ deleted: 1, remaining: 0 });
});

it("recovers an expired verification lease and retries failed garbage deletion with backoff", async () => {
  let now = 0;
  let releaseHead: (() => void) | undefined;
  let signalHead: (() => void) | undefined;
  const headStarted = new Promise<void>((resolve) => {
    signalHead = resolve;
  });
  const headGate = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
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
  const fileSystem = createTestFileSystem({
    opaqueStore: store,
    now: () => now,
    uploadSettlementGraceMs: 1,
  });
  const upload = await fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 60_000 });
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
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  await putOpaque(fileSystem, store, "/source", "source");
  await putOpaque(fileSystem, store, "/destination", "destination");
  expect(store.operations.puts).toBe(2);

  expect(await fileSystem.move("/source", "/destination", { replace: true })).toMatchObject({
    moved: 1,
    replaced: true,
  });
  expect(store.operations.puts).toBe(2);
  expect(await fileSystem.drainGarbage()).toMatchObject({ deleted: 1 });
  expect((await readOpaque(fileSystem, store, "/destination")).stat.sizeBytes).toBe(6);
});

it("queues every newly unreachable generation in one recursive removal", async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  await putOpaque(fileSystem, store, "/tree/a", "a", { createParents: true });
  await putOpaque(fileSystem, store, "/tree/sub/b", "b", { createParents: true });

  expect(await fileSystem.remove("/tree", { recursive: true })).toMatchObject({
    removed: 4,
    opaqueObjectsQueuedForDeletion: 2,
  });
  expect(await fileSystem.drainGarbage(100)).toEqual({ deleted: 2, remaining: 0 });
  expect(store.operations.deleteRequests).toBe(1);
  expect(store.operations.deletedKeys).toBe(2);
});
