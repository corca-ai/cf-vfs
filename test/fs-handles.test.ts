import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { NodeSqlFileSystem } from "../src/testing/node.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { putOpaque } from "../src/vfs/opaque.js";

it("shares live and detached inode writes while names can be reused", async () => {
  const vfs = new NodeSqlFileSystem();
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "old");
    const a = await f.open("/a", "r+");
    const b = await f.open("/a", "r+");
    expect(a.fd).not.toBe(b.fd);
    const ino = (await a.stat()).ino;
    await f.rename("/a", "/moved");
    await a.write("new", 0, "utf8");
    expect(await f.readFile("/moved", "utf8")).toBe("new");
    await f.unlink("/moved");
    await f.writeFile("/moved", "other");
    await a.write("yes", 0, "utf8");
    await expect(Reflect.apply(b.readFile, b, ["hex"])).rejects.toMatchObject({ code: "ENOTSUP" });
    expect(await b.readFile("utf8")).toBe("yes");
    expect((await b.stat()).ino).toBe(ino);
    expect((await b.stat()).nlink).toBe(0);
    await a.close();
    expect((await b.stat()).size).toBe(3);
    await b.close();
    expect(await f.readFile("/moved", "utf8")).toBe("other");
    await expect(a.stat()).rejects.toMatchObject({ code: "EBADF" });
  } finally {
    vfs.close();
  }
});

it("retains rename's replaced destination and recursive removal's open descendants", async () => {
  const vfs = new NodeSqlFileSystem();
  const f = createFsAdapter(vfs).promises;
  try {
    await f.mkdir("/dir");
    await f.writeFile("/source", "new");
    await f.writeFile("/dir/dest", "old");
    const old = await f.open("/dir/dest", "r+");
    await f.rename("/source", "/dir/dest");
    expect(await old.readFile("utf8")).toBe("old");
    const current = await f.open("/dir/dest", "r");
    await f.rm("/dir", { recursive: true });
    expect(await current.readFile("utf8")).toBe("new");
    await old.close();
    await current.close();
  } finally {
    vfs.close();
  }
});

it("accounts detached bytes until the last close and permits shrinking above quota", async () => {
  const vfs = new NodeSqlFileSystem({ maxInlineLogicalBytes: 5 });
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "12345");
    const handle = await f.open("/a", "r+");
    await f.unlink("/a");
    await expect(f.writeFile("/b", "x")).rejects.toMatchObject({ code: "ENOSPC" });
    await handle.truncate(3);
    await f.writeFile("/b", "xx");
    await expect(handle.write("xxx", 3)).rejects.toMatchObject({ code: "ENOSPC" });
    await handle.close();
    await f.writeFile("/b", "12345");
  } finally {
    vfs.close();
  }
});

it("supports positional writes, holes, shared append and truncation without moving explicit cursors", async () => {
  const vfs = new NodeSqlFileSystem({ chunkBytes: 4 });
  const f = createFsAdapter(vfs).promises;
  try {
    const a = await f.open("/a", "w+");
    await a.write("ab", 0);
    await a.write("z", 5);
    expect(Array.from(await f.readFile("/a"))).toEqual([97, 98, 0, 0, 0, 122]);
    const out = new Uint8Array(2);
    expect((await a.read(out)).bytesRead).toBe(2);
    expect([...out]).toEqual([97, 98]);
    await a.truncate(1);
    await a.truncate(4);
    expect([...(await f.readFile("/a"))]).toEqual([97, 0, 0, 0]);
    const b = await f.open("/a", "a");
    await Promise.all([b.write("x", 0), b.write("y", 0)]);
    expect([...(await f.readFile("/a"))]).toEqual([97, 0, 0, 0, 120, 121]);
    await Promise.all([a.close(), b.close()]);
  } finally {
    vfs.close();
  }
});

it("checks credentials at open and keeps the granted descriptor rights after chmod", async () => {
  const vfs = new NodeSqlFileSystem();
  try {
    await vfs.writeFile("/a", "old");
    vfs.setMetadata("/a", { mode: 0o100666 });
    const f = createFsAdapter(vfs.forCredentials({ uid: 1001, gid: 1001 })).promises;
    const h = await f.open("/a", "r+");
    vfs.setMetadata("/a", { mode: 0o100000 });
    await expect(f.open("/a", "r")).rejects.toMatchObject({ code: "EACCES" });
    await h.write("new", 0);
    expect(await h.readFile("utf8")).toBe("new");
    await h.close();
    const root = createFsAdapter(vfs).promises;
    const read = await root.open("/a", "r");
    await expect(read.write("x", 0)).rejects.toMatchObject({ code: "EBADF" });
    await read.close();
  } finally {
    vfs.close();
  }
});

it("serializes close behind reads and rejects new work as soon as close starts", async () => {
  const vfs = new NodeSqlFileSystem();
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "x");
    const h = await f.open("/a", "r");
    const read = h.readFile("utf8");
    const first = h.close();
    const second = h.close();
    await expect(h.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(await read).toBe("x");
    await Promise.all([first, second]);
  } finally {
    vfs.close();
  }
});

it("keeps open copy destinations live across repeated overwrite without exceeding quota", async () => {
  const vfs = new NodeSqlFileSystem({ maxInlineLogicalBytes: 8 });
  const f = createFsAdapter(vfs).promises;
  try {
    await f.writeFile("/a", "1234");
    await f.writeFile("/source", "abcd");
    const h = await f.open("/a", "r+");
    await vfs.copy("/source", "/a", { replace: true });
    await vfs.copy("/source", "/a", { replace: true });
    expect(await h.readFile("utf8")).toBe("abcd");
    await expect(f.writeFile("/extra", "x")).rejects.toMatchObject({ code: "ENOSPC" });
    await h.close();
  } finally {
    vfs.close();
  }
});

it("grants requested descriptor access when creating a mode-zero file", async () => {
  const vfs = new NodeSqlFileSystem();
  try {
    vfs.mkdir("/dir");
    vfs.setMetadata("/dir", { mode: 0o40777 });
    const f = createFsAdapter(vfs.forCredentials({ uid: 123, gid: 123 })).promises;
    const h = await f.open("/dir/new", "w+", 0);
    await h.writeFile("ok");
    expect((await h.stat()).mode & 0o777).toBe(0);
    await expect(f.open("/dir/new", "r")).rejects.toMatchObject({ code: "EACCES" });
    await h.close();
  } finally {
    vfs.close();
  }
});

it("bounds positional reads and writes to the affected chunks", async () => {
  let statements = 0;
  const vfs = new NodeSqlFileSystem({
    chunkBytes: 4,
    maxInFlightBufferedBytes: 1000,
    onStatement: () => statements++,
  });
  const f = createFsAdapter(vfs).promises;
  try {
    // Streaming creation does not require whole-file materialization.
    await vfs.writeFile(
      "/a",
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(400).fill(65));
          c.close();
        },
      }),
    );
    const h = await f.open("/a", "r+");
    statements = 0;
    await h.write("x", 0);
    const writeStatements = statements;
    statements = 0;
    const out = new Uint8Array(1);
    await h.read(out, 0, 1, 399);
    expect(out[0]).toBe(65);
    expect(writeStatements).toBeLessThan(12);
    expect(statements).toBeLessThan(6);
    await h.close();
  } finally {
    vfs.close();
  }
});

it("does not scan unrelated open descriptors on single-file unlink", async () => {
  let statements = 0;
  const vfs = new NodeSqlFileSystem({ onStatement: () => statements++ });
  const f = createFsAdapter(vfs).promises;
  try {
    const handles = [];
    for (let i = 0; i < 100; i++) handles.push(await f.open(`/open-${i}`, "w"));
    await f.writeFile("/unopened", "x");
    statements = 0;
    await f.unlink("/unopened");
    expect(statements).toBeLessThan(20);
    await Promise.all(handles.map((h) => h.close()));
  } finally {
    vfs.close();
  }
});

it("refuses opaque descriptor reads when the lease expires during store acquisition", async () => {
  let now = 100;
  class ExpiringStore extends MemoryOpaqueStore {
    override async getStream(...args: Parameters<MemoryOpaqueStore["getStream"]>) {
      const stream = await super.getStream(...args);
      now += 60_000;
      return stream;
    }
  }
  const store = new ExpiringStore();
  const vfs = new NodeSqlFileSystem({ opaqueStore: store, now: () => now });
  try {
    await putOpaque(vfs, store, "/a", "body");
    const h = await createFsAdapter(vfs).promises.open("/a", "r");
    await expect(h.readFile("utf8")).rejects.toMatchObject({ code: "EIO" });
    await h.close();
  } finally {
    vfs.close();
  }
});
