import { expect, it } from "vitest";
import { TieredFileContent } from "../src/fs/content.js";
import { createFsAdapter } from "../src/fs/index.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

function tiered() {
  const store = new MemoryOpaqueStore();
  const vfs = createTestFileSystem({ opaqueStore: store });
  const content = new TieredFileContent(vfs, store, { inlineBytes: 8 });
  return {
    store,
    vfs,
    content,
    fs: createFsAdapter(vfs, { content, maxReadFileBytes: 32 }).promises,
  };
}

it("round trips large bodies through the immutable tier and keeps small bodies inline", async () => {
  const { store, vfs, fs } = tiered();
  await fs.writeFile("/small", "small");
  await fs.writeFile(
    "/large",
    Uint8Array.from({ length: 16 }, (_, i) => i),
  );
  expect(vfs.stat("/small")).toMatchObject({ contentClass: "inline" });
  expect(vfs.stat("/large")).toMatchObject({ contentClass: "opaque", sizeBytes: 16 });
  expect(await fs.readFile("/large")).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i));
  expect(store.operations).toMatchObject({ puts: 1, heads: 1, gets: 1 });
});

it("reads ranges without losing full-size metadata and supports explicit streamed writes", async () => {
  const { content } = tiered();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(Uint8Array.of(1, 2, 3, 4));
      c.close();
    },
  });
  await content.write("/file", stream, { storage: "opaque" });
  const read = await content.open("/file", { offset: 1, length: 2 });
  expect(read.stat.sizeBytes).toBe(4);
  expect(await readAllBytes(read.stream, 4)).toEqual(Uint8Array.of(2, 3));
  const empty = await content.open("/file", { offset: 99, length: 1 });
  expect(await readAllBytes(empty.stream, 4)).toHaveLength(0);
});

it("preserves disposition, optimistic guards and opaque-to-inline replacement", async () => {
  const { content, vfs, fs } = tiered();
  await fs.writeFile("/file", "0123456789");
  const stat = vfs.stat("/file");
  await expect(
    content.write("/file", "replacement", { disposition: "create" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  await expect(
    content.write("/missing", "replacement", { disposition: "replace" }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  vfs.touch("/file");
  await expect(
    content.write("/file", "replacement", { ifMutationToken: stat.mutationToken }),
  ).rejects.toMatchObject({ code: "EREVISION" });
  await fs.writeFile("/file", "small");
  expect(vfs.stat("/file")).toMatchObject({ contentClass: "inline" });
  expect(await fs.readFile("/file", "utf8")).toBe("small");
});

it("writes through dangling symlinks with a persisted traversal guard", async () => {
  const { content, vfs } = tiered();
  vfs.symlink("/link", "/target");
  await content.write("/link", "0123456789");
  expect(vfs.stat("/target")).toMatchObject({ contentClass: "opaque", sizeBytes: 10 });
});

it("rejects expired read leases instead of returning short data", async () => {
  let now = 100;
  const store = new MemoryOpaqueStore();
  const vfs = createTestFileSystem({ opaqueStore: store, now: () => now });
  const content = new TieredFileContent(vfs, store, { inlineBytes: 8, leaseMs: 1, now: () => now });
  await content.write("/file", "0123456789");
  const opened = await content.open("/file");
  now = 102;
  await expect(readAllBytes(opened.stream, 32)).rejects.toMatchObject({ code: "EIO" });
});

it("keeps read permissions and declines user-view upload administration", async () => {
  const { vfs, store, fs } = tiered();
  await fs.writeFile("/file", "0123456789", { mode: 0o600 });
  const user = new TieredFileContent(vfs.forCredentials({ uid: 1, gid: 1 }), store, {
    inlineBytes: 8,
  });
  await expect(user.open("/file")).rejects.toMatchObject({ code: "EACCES" });
  await expect(user.write("/other", "0123456789")).rejects.toMatchObject({ code: "EPERM" });
});

it("detects transport truncation and makes missing bodies an error", async () => {
  const { vfs, store, content } = tiered();
  await content.write("/file", "0123456789");
  const lease = vfs.resolveOpaqueRead("/file");
  await store.delete([lease.object.key]);
  await expect(content.open("/file")).rejects.toMatchObject({ code: "EIO" });
});

it("rejects a path changed while its immutable body is uploading", async () => {
  class RacingStore extends MemoryOpaqueStore {
    duringPut: (() => void) | undefined;
    override putIfAbsent(...args: Parameters<MemoryOpaqueStore["putIfAbsent"]>) {
      this.duringPut?.();
      return super.putIfAbsent(...args);
    }
  }
  const store = new RacingStore();
  const vfs = createTestFileSystem({ opaqueStore: store });
  await vfs.writeFile("/file", "old");
  store.duringPut = () => {
    vfs.touch("/file");
  };
  const content = new TieredFileContent(vfs, store, { inlineBytes: 8 });
  await expect(content.write("/file", "0123456789")).rejects.toMatchObject({ code: "EREVISION" });
  expect(vfs.stat("/file")).toMatchObject({ contentClass: "inline", sizeBytes: 3 });
});

it("rejects a body shorter than its leased metadata", async () => {
  class ShortStore extends MemoryOpaqueStore {
    override getStream() {
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(Uint8Array.of(1));
            c.close();
          },
        }),
      );
    }
  }
  const store = new ShortStore();
  const vfs = createTestFileSystem({ opaqueStore: store });
  const content = new TieredFileContent(vfs, store, { inlineBytes: 8 });
  await content.write("/file", "0123456789");
  const opened = await content.open("/file");
  await expect(readAllBytes(opened.stream, 32)).rejects.toMatchObject({ code: "EIO" });
});

it("cancels an opened opaque body exactly once", async () => {
  class CancelStore extends MemoryOpaqueStore {
    cancelled = 0;
    override getStream() {
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(Uint8Array.of(1));
          },
          cancel: () => {
            this.cancelled += 1;
          },
        }),
      );
    }
  }
  const store = new CancelStore();
  const vfs = createTestFileSystem({ opaqueStore: store });
  const content = new TieredFileContent(vfs, store, { inlineBytes: 8 });
  await content.write("/file", "0123456789");
  const opened = await content.open("/file");
  await opened.stream.cancel();
  expect(store.cancelled).toBe(1);
});

it("checks storage existence even for an empty opaque body", async () => {
  const { content, vfs, store } = tiered();
  await content.write("/empty", "", { storage: "opaque" });
  const lease = vfs.resolveOpaqueRead("/empty");
  await store.delete([lease.object.key]);
  await expect(content.open("/empty")).rejects.toMatchObject({ code: "EIO" });
});

it("writes opaque bodies through dot components and symlinks", async () => {
  const { vfs, store, content } = tiered();
  vfs.mkdir("/dir/sub", true);
  vfs.symlink("/link", "/dir/sub");
  await content.write("/link/../body", "0123456789");
  expect(store.operations.puts).toBe(1);
  expect(vfs.stat("/dir/body").contentClass).toBe("opaque");
});

it("rejects a repointed link during opaque upload without changing either target", async () => {
  const { vfs, content, fs } = tiered();
  vfs.mkdir("/a");
  vfs.mkdir("/b");
  vfs.symlink("/link", "/a");
  await fs.writeFile("/a/body", "old-a");
  await fs.writeFile("/b/body", "old-b");
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      vfs.symlink("/link", "/b", { replace: true });
      controller.enqueue(new TextEncoder().encode("0123456789"));
      controller.close();
    },
  });
  await expect(content.write("/link/body", stream, { storage: "opaque" })).rejects.toMatchObject({
    code: "EREVISION",
  });
  expect(await fs.readFile("/a/body", "utf8")).toBe("old-a");
  expect(await fs.readFile("/b/body", "utf8")).toBe("old-b");
});

it("appends opaque content through links with bounded streaming", async () => {
  const { vfs, fs } = tiered();
  await fs.writeFile("/body", "0123456789");
  vfs.symlink("/link", "/body");
  await fs.writeFile("/link", "ab", { flag: "a" });
  expect(await fs.readFile("/body", "utf8")).toBe("0123456789ab");
});
