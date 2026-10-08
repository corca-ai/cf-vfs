import { expect, it } from "vitest";
import { FsMetadataCache } from "../src/fs/metadata.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

function cached(maxEntries = 4096) {
  const cache = new FsMetadataCache(maxEntries);
  let statements = 0;
  const fileSystem = createTestFileSystem({
    onEvent: cache.onEvent,
    onStatement: () => {
      statements += 1;
    },
  });
  return { cache, fileSystem, count: () => statements };
}

it("reuses listing metadata and returns independent stat objects", async () => {
  const { cache, fileSystem, count } = cached();
  fileSystem.mkdir("/dir");
  await fileSystem.writeFiles([
    { path: "/dir/a", body: "a" },
    { path: "/dir/b", body: "b" },
  ]);
  cache.list(fileSystem, "/dir");
  const before = count();
  const stat = cache.stat(fileSystem, "/dir/a", false);
  stat.mode = 0;
  expect(cache.stat(fileSystem, "/dir/a", true).mode).toBe(fileSystem.stat("/dir/a").mode);
  cache.stat(fileSystem, "/dir/b", false);
  expect(count() - before).toBe(1); // Only the uncached reference lookup above.
});

it("invalidates after direct writes, ownership and recursive moves/removals", async () => {
  const { cache, fileSystem } = cached();
  await fileSystem.writeFile("/dir/a", "old", { createParents: true });
  cache.list(fileSystem, "/dir");
  await fileSystem.writeFile("/dir/a", "longer");
  expect(cache.stat(fileSystem, "/dir/a", false).sizeBytes).toBe(6);
  fileSystem.setOwnership("/dir/a", { uid: 12 });
  expect(cache.stat(fileSystem, "/dir/a", false).uid).toBe(12);
  await fileSystem.move("/dir", "/moved");
  expect(() => cache.stat(fileSystem, "/dir/a", false)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(cache.stat(fileSystem, "/moved/a", false).sizeBytes).toBe(6);
  await fileSystem.remove("/moved", { recursive: true });
  expect(() => cache.stat(fileSystem, "/moved/a", false)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
});

it("does not confuse symlink metadata with its target or reuse repointed paths", async () => {
  const { cache, fileSystem } = cached();
  await fileSystem.writeFile("/a", "one");
  await fileSystem.writeFile("/b", "longer");
  fileSystem.symlink("/link", "/a");
  cache.list(fileSystem, "/");
  expect(cache.stat(fileSystem, "/link", false).kind).toBe("symlink");
  expect(cache.stat(fileSystem, "/link", true).sizeBytes).toBe(3);
  await fileSystem.remove("/link");
  fileSystem.symlink("/link", "/b");
  expect(cache.stat(fileSystem, "/link", true).sizeBytes).toBe(6);
  expect(() => cache.stat(fileSystem, "/a/", false)).toThrow(
    expect.objectContaining({ code: "ENOTDIR" }),
  );
});

it("does not turn directory read permission into child search permission", async () => {
  const { cache, fileSystem } = cached();
  fileSystem.mkdir("/dir", false, 0o040744);
  await fileSystem.writeFile("/dir/a", "secret");
  const user = fileSystem.forCredentials({ uid: 1, gid: 1 });
  expect(() => cache.list(user, "/dir")).toThrow(expect.objectContaining({ code: "EACCES" }));
  expect(() => cache.stat(user, "/dir/a", false)).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
});

it("invalidates ancestor permission changes and refuses to share credential views", async () => {
  const { cache, fileSystem } = cached();
  await fileSystem.writeFile("/dir/a", "a", { createParents: true });
  const user = fileSystem.forCredentials({ uid: 1, gid: 1 });
  cache.list(user, "/dir");
  fileSystem.setMetadata("/dir", { mode: 0o040700 });
  expect(() => cache.stat(user, "/dir/a", false)).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
  expect(() => cache.stat(fileSystem, "/dir/a", false)).toThrow(
    expect.objectContaining({ code: "EINVAL" }),
  );
});

it("bounds the cache and retains correctness after eviction", async () => {
  const { cache, fileSystem, count } = cached(1);
  await fileSystem.writeFiles([
    { path: "/a", body: "a" },
    { path: "/b", body: "b" },
  ]);
  cache.list(fileSystem, "/");
  const before = count();
  expect(cache.stat(fileSystem, "/a", false).sizeBytes).toBe(1);
  expect(count() - before).toBe(1);
  expect(() => new FsMetadataCache(0)).toThrow(expect.objectContaining({ code: "EINVAL" }));
});

it("does not discard opaque object metadata when warming from a listing", async () => {
  const { MemoryOpaqueStore } = await import("../src/testing/opaque-store.js");
  const { putOpaque } = await import("../src/vfs/opaque.js");
  const cache = new FsMetadataCache();
  const store = new MemoryOpaqueStore();
  const vfs = createTestFileSystem({ opaqueStore: store, onEvent: cache.onEvent });
  await putOpaque(vfs, store, "/opaque", "body", { contentType: "text/plain" });
  cache.list(vfs, "/");
  expect(cache.stat(vfs, "/opaque", false)).toMatchObject({ contentType: "text/plain" });
});
