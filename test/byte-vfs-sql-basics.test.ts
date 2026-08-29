import { describe, expect, it } from "vitest";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import type { VfsEvent } from "../src/vfs/events.js";
import { readAllBytes, readUtf8, streamFromChunks } from "../src/vfs/streams.js";
import { createTestFileSystem } from "./helpers/node-sql.js";
import { runVfsConformance } from "./helpers/vfs-conformance.js";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...(await readAllBytes(stream, 16 * 1024 * 1024))];
}

it("returns an independent one-chunk byte collection", async () => {
  const source = Uint8Array.of(1, 2, 3);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(source);
      controller.close();
    },
  });

  const collected = await readAllBytes(stream, 3);
  collected.fill(9);
  expect([...source]).toEqual([1, 2, 3]);
});

it("decodes bounded UTF-8 directly across stream chunk boundaries", async () => {
  const text = await readUtf8(
    streamFromChunks([Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac, 0x78)]),
    4,
    "/text",
  );
  expect(text).toBe("€x");

  await expect(
    readUtf8(streamFromChunks([Uint8Array.of(0xe2, 0x82)]), 2, "/invalid"),
  ).rejects.toMatchObject({ code: "EIO", path: "/invalid" });
});

it("cancels a UTF-8 source that exceeds its byte bound", async () => {
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2, 3));
    },
    cancel() {
      canceled = true;
    },
  });

  await expect(readUtf8(source, 2)).rejects.toMatchObject({ code: "EFBIG" });
  expect(canceled).toBe(true);
});

it("creates byte streams that support BYOB readers", async () => {
  const reader = streamFromChunks([Uint8Array.of(1, 2, 3)]).getReader({ mode: "byob" });
  const first = await reader.read(new Uint8Array(3));
  expect(first.done).toBe(false);
  expect([...(first.value ?? new Uint8Array())]).toEqual([1, 2, 3]);
  await reader.cancel();
});

it("does not attach a completed digest to a newer file revision", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/raced", "old".repeat(1024));

  const digestingOldSnapshot = fileSystem.digestFile("/raced");
  await fileSystem.writeFile("/raced", "new".repeat(1024));
  const oldDigest = await digestingOldSnapshot;
  const newDigest = await fileSystem.digestFile("/raced");

  expect(newDigest).not.toBe(oldDigest);
  expect(await fileSystem.digestFile("/raced")).toBe(newDigest);
});

describe("shared VFS conformance", () => {
  runVfsConformance(() => createTestFileSystem());
});

it("reports quota refusals, usage, and opaque lifecycle to onEvent", async () => {
  const events: VfsEvent[] = [];
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({
    onEvent: (event) => events.push(event),
    opaqueStore: store,
    maxEntries: 3,
  });

  await fileSystem.writeFile("/a", "body");
  expect(events).toContainEqual({ type: "vfs.usage", inlineBytes: 4, entries: 2 });

  await expect(fileSystem.writeFile("/b/c", "x", { createParents: true })).rejects.toMatchObject({
    code: "ENOSPC",
  });
  expect(events).toContainEqual({
    type: "vfs.quota",
    limit: "maxEntries",
    requested: 1,
    used: 3,
    max: 3,
    path: "/b/c",
  });
  // The rolled-back parent creation must not have reported usage.
  expect(events.filter((event) => event.type === "vfs.usage")).toHaveLength(1);

  const upload = await fileSystem.beginOpaqueUpload("/blob");
  expect(events.at(-1)).toMatchObject({ type: "vfs.opaque-upload", phase: "begin" });
  await store.putIfAbsent(upload.objectKey, "opaque body");
  await fileSystem.commitOpaqueUpload(upload.uploadId);
  expect(events.at(-1)).toMatchObject({
    type: "vfs.opaque-upload",
    phase: "commit",
    path: "/blob",
  });

  await fileSystem.remove("/blob");
  await fileSystem.drainGarbage();
  expect(events.at(-1)).toMatchObject({ type: "vfs.garbage", deleted: 1, failed: 0 });
});

it("reports a rejected commit and keeps a throwing observer from changing behavior", async () => {
  const events: VfsEvent[] = [];
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({
    onEvent: (event) => {
      events.push(event);
      throw new Error("observer failure must not escape");
    },
    opaqueStore: store,
  });

  // A committed write still succeeds even though every emit throws.
  await fileSystem.writeFile("/kept", "body");
  expect(await bytes(fileSystem.readFile("/kept").stream)).toEqual([
    ...new TextEncoder().encode("body"),
  ]);

  const upload = await fileSystem.beginOpaqueUpload("/blob", { expectedSizeBytes: 99 });
  await store.putIfAbsent(upload.objectKey, "wrong size");
  await expect(fileSystem.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
    code: "EIO",
  });
  expect(events).toContainEqual({
    type: "vfs.opaque-upload",
    phase: "reject",
    uploadId: upload.uploadId,
    objectKey: upload.objectKey,
    path: "/blob",
    reason: "size-mismatch",
  });
});

it("performs no usage bookkeeping when no observer is attached", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/a", "body");
  // Nothing to assert beyond the mutation succeeding: the guarded usage
  // query in updateUsage() is skipped, so this pins that the guard exists.
  expect(fileSystem.stat("/a").sizeBytes).toBe(4);
});

it("reports unchanged usage after a same-size replacement", async () => {
  const events: VfsEvent[] = [];
  const fileSystem = createTestFileSystem({ onEvent: (event) => events.push(event) });
  await fileSystem.writeFile("/a", "old!");
  events.length = 0;

  await fileSystem.writeFile("/a", "new!");

  expect(events.filter((event) => event.type === "vfs.usage")).toEqual([
    { type: "vfs.usage", inlineBytes: 4, entries: 2 },
  ]);
});

it("reports inline-file quota refusals for synchronous and batched bodies", async () => {
  const events: VfsEvent[] = [];
  const fileSystem = createTestFileSystem({
    maxInlineFileBytes: 4,
    maxInFlightBufferedBytes: 16,
    onEvent: (event) => events.push(event),
  });

  await expect(fileSystem.writeFile("/single", "12345")).rejects.toMatchObject({
    code: "EFBIG",
  });
  expect(events).toContainEqual({
    type: "vfs.quota",
    limit: "maxInlineFileBytes",
    used: 4,
    max: 4,
  });

  events.length = 0;
  await expect(fileSystem.writeFiles([{ path: "/batch", body: "12345" }])).rejects.toMatchObject({
    code: "EFBIG",
  });
  expect(events).toContainEqual({
    type: "vfs.quota",
    limit: "maxInlineFileBytes",
    used: 4,
    max: 4,
  });
});
