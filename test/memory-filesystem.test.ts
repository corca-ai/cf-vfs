import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../src/testing/memory.js";

describe("MemoryFileSystem", () => {
  it("does not create parents when replace targets a missing file", () => {
    const fileSystem = new MemoryFileSystem();

    expect(() => fileSystem.writeText("/must-not-remain/file", "missing", {
      createParents: true,
      disposition: "replace",
    })).toThrowError(expect.objectContaining({
      code: "ENOENT",
      path: "/must-not-remain/file",
    }));
    expect(() => fileSystem.stat("/must-not-remain")).toThrowError(
      expect.objectContaining({ code: "ENOENT", path: "/must-not-remain" }),
    );
  });

  it("leaves existing state and missing parents unchanged after an oversized write", () => {
    const fileSystem = new MemoryFileSystem({ maxTextFileBytes: 3 });
    fileSystem.writeText("/existing", "old");
    const before = fileSystem.readText("/existing");

    expect(() => fileSystem.writeText("/existing", "four"))
      .toThrowError(expect.objectContaining({ code: "EFBIG", path: "/existing" }));
    expect(fileSystem.readText("/existing")).toEqual(before);

    expect(() => fileSystem.writeText("/new/file", "four", { createParents: true }))
      .toThrowError(expect.objectContaining({ code: "EFBIG", path: "/new/file" }));
    expect(() => fileSystem.stat("/new")).toThrowError(
      expect.objectContaining({ code: "ENOENT", path: "/new" }),
    );
  });

  it("leaves content and metadata unchanged after a stale append", () => {
    const fileSystem = new MemoryFileSystem();
    const written = fileSystem.writeText("/log", "hello");
    fileSystem.appendText("/log", " world", { ifRevision: written.revision });
    const before = fileSystem.readText("/log");

    expect(() => fileSystem.appendText("/log", " stale", { ifRevision: written.revision }))
      .toThrowError(expect.objectContaining({ code: "EREVISION", path: "/log" }));
    expect(fileSystem.readText("/log")).toEqual(before);
  });

  it("treats an empty append as an idempotent write", () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.writeText("/log", "hello");
    const before = fileSystem.readText("/log");

    const result = fileSystem.appendText("/log", "");

    expect(result).toMatchObject({
      path: "/log",
      revision: before.stat.revision,
      sizeBytes: before.stat.sizeBytes,
      created: false,
    });
    expect(fileSystem.readText("/log")).toEqual(before);
  });

  it("touches metadata without rewriting file content", () => {
    const fileSystem = new MemoryFileSystem();
    const written = fileSystem.writeText("/log", "hello world\nnext");

    const touched = fileSystem.touch("/log", {
      ifRevision: written.revision,
      mode: 0o100600,
      modifiedAtMs: 1234,
    });

    expect(touched).toMatchObject({
      mode: 0o100600,
      modifiedAtMs: 1234,
      revision: written.revision + 1,
    });
    expect(fileSystem.readText("/log").text).toBe("hello world\nnext");
  });

  it("returns metadata copies that callers cannot use to mutate the filesystem", () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.writeText("/file", "content");

    const external = fileSystem.stat("/file");
    external.mode = 0;
    external.path = "/changed";

    expect(fileSystem.stat("/file")).toMatchObject({ path: "/file", mode: 0o100644 });
  });

  it("moves a subtree while preserving descendant metadata", () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.writeText("/source/nested/file", "content", { createParents: true });
    const source = fileSystem.stat("/source");
    const child = fileSystem.stat("/source/nested/file");

    const moved = fileSystem.move("/source", "/destination");

    expect(moved).toEqual({
      from: "/source",
      to: "/destination",
      moved: 3,
      replaced: false,
    });
    expect(() => fileSystem.stat("/source")).toThrowError(
      expect.objectContaining({ code: "ENOENT", path: "/source" }),
    );
    expect(fileSystem.readText("/destination/nested/file").text).toBe("content");
    expect(fileSystem.stat("/destination").revision).toBe(source.revision + 1);
    expect(fileSystem.stat("/destination/nested/file")).toMatchObject({
      revision: child.revision,
      createdAtMs: child.createdAtMs,
      modifiedAtMs: child.modifiedAtMs,
    });
  });

  it("does not change either subtree when replacement targets a non-empty directory", () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.writeText("/source/file", "source", { createParents: true });
    fileSystem.writeText("/target/file", "target", { createParents: true });

    expect(() => fileSystem.move("/source", "/target", { replace: true }))
      .toThrowError(expect.objectContaining({ code: "ENOTEMPTY", path: "/target" }));
    expect(fileSystem.readText("/source/file").text).toBe("source");
    expect(fileSystem.readText("/target/file").text).toBe("target");
  });

  it("uses keyset cursors so insertions before a page do not reappear", () => {
    const fileSystem = new MemoryFileSystem();
    for (const name of ["a", "b", "c"]) {
      fileSystem.writeText(`/page/${name}`, name, { createParents: true });
    }

    const first = fileSystem.listPage("/page", { limit: 2 });
    expect(first).toMatchObject({
      entries: [{ path: "/page/a" }, { path: "/page/b" }],
      nextCursor: "/page/b",
      scanned: 2,
    });

    fileSystem.writeText("/page/aa", "inserted before the cursor");
    expect(fileSystem.listPage("/page", { limit: 2, cursor: "/page/b" })).toMatchObject({
      entries: [{ path: "/page/c" }],
      nextCursor: null,
      scanned: 1,
    });
  });

  it("continues traversal after an empty filtered page", () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.mkdir("/page/a", true);
    fileSystem.mkdir("/page/b");
    fileSystem.writeText("/page/c.txt", "match");

    const empty = fileSystem.findPage({ path: "/page", type: "file", limit: 2 });
    expect(empty).toEqual({ entries: [], nextCursor: "/page/b", scanned: 2 });

    expect(fileSystem.findPage({
      path: "/page",
      type: "file",
      limit: 2,
      cursor: "/page/b",
    })).toMatchObject({
      entries: [{ path: "/page/c.txt" }],
      nextCursor: null,
      scanned: 1,
    });
  });
});
