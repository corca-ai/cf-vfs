import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { NodeSqlFileSystem } from "../src/testing/node.js";
import type { VfsEvent } from "../src/vfs/events.js";

class RecursiveSqlFileSystem extends NodeSqlFileSystem {
  enableRecursiveTriggers(): void {
    this.storage.sql.exec("PRAGMA recursive_triggers = ON");
  }
}

it.each([
  [4, "live"],
  [4, "linked"],
  [4, "detached"],
  [8, "live"],
  [8, "linked"],
  [8, "detached"],
] as const)(
  "preserves partial/full writes and truncate boundaries: %i %s",
  async (width, state) => {
    const v = new RecursiveSqlFileSystem({ chunkBytes: width });
    const f = createFsAdapter(v).promises;
    v.enableRecursiveTriggers();
    try {
      await f.writeFile("/a", new Uint8Array(33).fill(65));
      const h = await f.open("/a", "r+");
      if (state === "linked") await f.link("/a", "/alias");
      if (state === "detached") await f.unlink("/a");
      let expected = new Uint8Array(33).fill(65);
      for (const [offset, length] of [
        [0, 16],
        [1, 16],
        [16, 17],
        [40, 9],
      ] as const) {
        const body = new Uint8Array(length).fill(66);
        const next = new Uint8Array(Math.max(expected.length, offset + length));
        next.set(expected);
        next.set(body, offset);
        expected = next;
        await h.write(body, 0, length, offset);
        const output = new Uint8Array(expected.length);
        await h.read(output, 0, output.length, 0);
        expect(output).toEqual(expected);
      }
      for (const size of [49, 33, 17, 16, 9, 8, 7, 1, 0, 0, 5]) {
        const next = new Uint8Array(size);
        next.set(expected.subarray(0, size));
        expected = next;
        await h.truncate(size);
        const output = new Uint8Array(size);
        await h.read(output, 0, size, 0);
        expect(output).toEqual(expected);
        expect((await h.stat()).size).toBe(size);
        if (state === "linked") expect(await f.readFile("/alias")).toEqual(expected);
      }
      await h.close();
    } finally {
      v.close();
    }
  },
);

it("keeps directory nlink and parent times across copy, replacement, mixed batches and rollback", async () => {
  let now = 10;
  const v = new NodeSqlFileSystem({ now: () => now });
  const f = createFsAdapter(v).promises;
  try {
    await f.mkdir("/a/sub", { recursive: true });
    await f.mkdir("/b");
    now = 20;
    await v.copy("/a", "/copy", { recursive: true });
    expect((await f.stat("/copy")).nlink).toBe(3);
    expect((await f.stat("/")).nlink).toBe(5);
    await f.rename("/copy/sub", "/b");
    expect((await f.stat("/copy")).nlink).toBe(2);
    expect((await f.stat("/")).nlink).toBe(5);
    now = 30;
    await v.writeFiles(
      [
        { path: "/copy/nested/file", body: "x" },
        { path: "/a/file", body: "y" },
      ],
      { createParents: true },
    );
    expect((await f.stat("/copy")).nlink).toBe(3);
    expect((await f.stat("/a")).nlink).toBe(3);
    expect((await f.stat("/a")).mtimeMs).toBe(30);
    await f.rm("/copy", { recursive: true });
    expect((await f.stat("/")).nlink).toBe(4);
    const token = v.getMutationToken("/");
    await expect(
      v.writeFiles(
        [
          { path: "/new/sub/file", body: "x" },
          { path: "/a", body: "bad" },
        ],
        { createParents: true },
      ),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(v.getMutationToken("/")).toBe(token);
    await f.writeFile("/plain", "x");
    expect((await f.stat("/")).nlink).toBe(4);
  } finally {
    v.close();
  }
});

it("keeps shared metadata publication while unrelated mutations retain their own feed", async () => {
  const events: VfsEvent[] = [];
  const v = new NodeSqlFileSystem({ recordChanges: true, onEvent: (event) => events.push(event) });
  const f = createFsAdapter(v).promises;
  try {
    await f.writeFile("/a", "old");
    await f.link("/a", "/alias");
    await f.writeFile("/plain", "x");
    const cursor = v.changesSince(0).cursor;
    const token = v.getMutationToken("/alias");
    events.length = 0;
    await f.chmod("/plain", 0o600);
    await f.chmod("/a", 0o640);
    await f.writeFile("/a", "new");
    expect(await f.readFile("/alias", "utf8")).toBe("new");
    expect((await f.stat("/alias")).mode & 0o777).toBe(0o640);
    expect(v.getMutationToken("/alias")).not.toBe(token);
    expect(
      v
        .changesSince(cursor)
        .changes.map((change) => change.path)
        .sort(),
    ).toEqual(["/a", "/alias", "/plain"]);
    expect(events.some((event) => event.type === "vfs.mutation" && event.path === "/alias")).toBe(
      true,
    );
  } finally {
    v.close();
  }
});
