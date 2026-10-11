import { expect, it } from "vitest";
import { FsMetadataIndex } from "../src/fs/metadata.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

function snapshot(fs: ReturnType<typeof createTestFileSystem>) {
  return fs.find({ path: "/", includeRoot: true }).sort((a, b) => a.path.localeCompare(b.path));
}
function indexed(index: FsMetadataIndex) {
  return index.snapshot().sort((a, b) => a.path.localeCompare(b.path));
}

it("bootstraps preexisting paths and refreshes overwrites, metadata, move, delete and recreation", async () => {
  const fs = createTestFileSystem({ recordChanges: true });
  fs.mkdir("/dir");
  await fs.writeFile("/dir/file", "one");
  const index = new FsMetadataIndex(fs);
  expect(index.refresh().updated).toHaveLength(3);
  expect(indexed(index)).toEqual(snapshot(fs));
  expect(index.refresh()).toEqual({ updated: [], removed: [] });
  await fs.writeFile("/dir/file", "two");
  fs.setMetadata("/dir/file", { mode: 0o600 });
  index.refresh();
  expect(indexed(index)).toEqual(snapshot(fs));
  await fs.move("/dir", "/renamed");
  index.refresh();
  expect(indexed(index)).toEqual(snapshot(fs));
  await fs.remove("/renamed", { recursive: true });
  await fs.writeFile("/renamed", "replacement");
  index.refresh();
  expect(indexed(index)).toEqual(snapshot(fs));
  const copy = index.snapshot();
  const first = copy[0];
  if (first === undefined) throw new Error("missing root");
  first.mode = 0;
  expect(indexed(index)).toEqual(snapshot(fs));
});

it("retains links as links, crosses page boundaries and works without statMany", async () => {
  const fs = createTestFileSystem({ recordChanges: true });
  await fs.writeFiles(Array.from({ length: 1000 }, (_, i) => ({ path: `/f${i}`, body: "x" })));
  fs.symlink("/link", "/f0");
  const fallback = new Proxy(fs, {
    get(target, key) {
      if (key === "statMany") return undefined;
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const index = new FsMetadataIndex(fallback);
  index.refresh();
  expect(indexed(index)).toEqual(snapshot(fs));
  await fs.writeFiles(Array.from({ length: 1000 }, (_, i) => ({ path: `/f${i}`, body: "new" })));
  index.refresh();
  expect(indexed(index)).toEqual(snapshot(fs));
});

it("refuses unavailable or untrusted feeds and leaves the last snapshot intact on capacity failure", async () => {
  const off = createTestFileSystem();
  expect(() => new FsMetadataIndex(off).refresh()).toThrow(
    expect.objectContaining({ code: "ENOTSUP" }),
  );
  const fs = createTestFileSystem({ recordChanges: true });
  expect(() => new FsMetadataIndex(fs.forCredentials({ uid: 0, gid: 0 })).refresh()).toThrow(
    expect.objectContaining({ code: "EPERM" }),
  );
  const index = new FsMetadataIndex(fs, 2);
  index.refresh();
  await fs.writeFile("/a", "a");
  index.refresh();
  const before = index.snapshot();
  await fs.writeFile("/b", "b");
  expect(() => index.refresh()).toThrow(expect.objectContaining({ code: "E2BIG" }));
  expect(index.snapshot()).toEqual(before);
  await fs.remove("/a");
  index.refresh();
  expect(indexed(index)).toEqual(snapshot(fs));
});

it("preserves opaque metadata and retries the same delta after a read failure", async () => {
  const { MemoryOpaqueStore } = await import("../src/testing/opaque-store.js");
  const { putOpaque } = await import("../src/vfs/opaque.js");
  const { VfsError } = await import("../src/core/errors.js");
  const store = new MemoryOpaqueStore();
  const fs = createTestFileSystem({ recordChanges: true, opaqueStore: store });
  await putOpaque(fs, store, "/opaque", "body", { contentType: "text/plain" });
  let fail = false;
  const view = new Proxy(fs, {
    get(target, key) {
      if (key === "statMany")
        return (...args: Parameters<typeof fs.statMany>) => {
          if (fail) throw new VfsError("EIO", "injected read failure");
          return target.statMany(...args);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const index = new FsMetadataIndex(view);
  index.refresh();
  expect(index.snapshot().find((entry) => entry.path === "/opaque")).toEqual(fs.lstat("/opaque"));
  const before = index.snapshot();
  await fs.writeFile("/new", "body");
  fail = true;
  expect(() => index.refresh()).toThrow(expect.objectContaining({ code: "EIO" }));
  expect(index.snapshot()).toEqual(before);
  fail = false;
  expect(index.refresh().updated.some((entry) => entry.path === "/new")).toBe(true);
  expect(index.snapshot().find((entry) => entry.path === "/opaque")).toEqual(fs.lstat("/opaque"));
});
