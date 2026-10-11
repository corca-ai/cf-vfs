import { expect, it } from "vitest";
import { VfsError } from "../src/core/errors.js";
import { statResult } from "../src/vfs/stat-many.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("matches individual stat and lstat results, preserving duplicates and path errors", async () => {
  const fs = createTestFileSystem();
  fs.mkdir("/dir");
  await fs.writeFile("/dir/file", "body");
  const paths = ["/dir/file", "/missing", "/dir", "/dir/file", "/dir/file/child"];
  for (const view of [fs, fs.forCredentials({ uid: 1000, gid: 1000 })]) {
    expect(view.statMany?.(paths)).toEqual(paths.map((path) => statResult(() => view.stat(path))));
    expect(view.statMany?.(paths, { follow: false })).toEqual(
      paths.map((path) => statResult(() => view.lstat(path))),
    );
  }
});

it("preserves symlink resolution, dot components, trailing slashes and malformed path errors", async () => {
  const fs = createTestFileSystem();
  fs.mkdir("/dir");
  await fs.writeFile("/dir/file", "body");
  fs.symlink("/alias", "/dir");
  fs.symlink("/loop", "/loop");
  const paths = [
    "/alias",
    "/alias/file",
    "/alias/../dir/file",
    "/dir/file/",
    "/loop",
    "",
    "/a\0b",
    "/한글",
    `/${"a".repeat(256)}`,
  ];
  for (const view of [fs, fs.forCredentials({ uid: 1000, gid: 1000 })]) {
    expect(view.statMany?.(paths)).toEqual(paths.map((path) => statResult(() => view.stat(path))));
    expect(view.statMany?.(paths, { follow: false })).toEqual(
      paths.map((path) => statResult(() => view.lstat(path))),
    );
  }
});

it("rechecks each principal and ancestor permissions after chmod", async () => {
  const fs = createTestFileSystem();
  fs.mkdir("/secret", false, 0o700);
  await fs.writeFile("/secret/file", "body");
  const user = fs.forCredentials({ uid: 1000, gid: 1000 });
  expect(user.statMany?.(["/secret", "/secret/file", "/secret/absent"])).toEqual(
    ["/secret", "/secret/file", "/secret/absent"].map((path) => statResult(() => user.stat(path))),
  );
  fs.setMetadata("/secret", { mode: 0o755 });
  expect(user.statMany?.(["/secret/file"])).toEqual([{ stat: user.stat("/secret/file") }]);
  fs.setMetadata("/secret", { mode: 0o700 });
  expect(user.statMany?.(["/secret/file"])).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: "EACCES" }) }),
  ]);
});

it("bounds requests, handles empty input and fetches ordinary paths as one set", async () => {
  let statements = 0;
  const fs = createTestFileSystem({ onStatement: () => statements++ });
  await fs.writeFiles(Array.from({ length: 100 }, (_, i) => ({ path: `/f${i}`, body: "x" })));
  statements = 0;
  expect(fs.statMany([])).toEqual([]);
  expect(statements).toBe(0);
  expect(fs.statMany(Array.from({ length: 100 }, (_, i) => `/f${i}`))).toHaveLength(100);
  expect(statements).toBe(2);
  expect(() => fs.statMany(Array(1001).fill("/"))).toThrow(VfsError);
  expect(() => Reflect.apply(fs.statMany, fs, [Array(2)])).toThrow(
    expect.objectContaining({ code: "EINVAL" }),
  );
});

it("preserves hard-link identities and opaque object metadata", async () => {
  const { createFsAdapter } = await import("../src/fs/index.js");
  const { MemoryOpaqueStore } = await import("../src/testing/opaque-store.js");
  const { putOpaque } = await import("../src/vfs/opaque.js");
  const store = new MemoryOpaqueStore();
  const fs = createTestFileSystem({ opaqueStore: store });
  await fs.writeFile("/file", "body");
  await createFsAdapter(fs).promises.link("/file", "/alias");
  await putOpaque(fs, store, "/opaque", "body", { contentType: "text/plain" });
  const paths = ["/file", "/alias", "/opaque"];
  expect(fs.statMany(paths)).toEqual(paths.map((path) => ({ stat: fs.stat(path) })));
  expect(fs.statMany(paths, { follow: false })).toEqual(
    paths.map((path) => ({ stat: fs.lstat(path) })),
  );
});

it("matches ordinary SQLite text binding behavior for lone surrogates", async () => {
  const fs = createTestFileSystem();
  await fs.writeFile("/bad\uFFFD", "body");
  await fs.writeFile("/emoji-😀", "body");
  const paths = ["/bad\uD800", "/bad\uFFFD", "/emoji-😀"];
  for (const view of [fs, fs.forCredentials({ uid: 1000, gid: 1000 })]) {
    expect(view.statMany?.(paths)).toEqual(paths.map((path) => statResult(() => view.stat(path))));
  }
});
