import { expect } from "vitest";
import { readAllBytes } from "../../src/vfs/streams.js";
import {
  conformanceCase,
  gatedBody,
  optionalConformanceCase,
  readText,
  refusal,
  streamThatFailsAfter,
  type VfsConformanceCase,
} from "./vfs-conformance-support.js";

export const CORE_CONFORMANCE: readonly VfsConformanceCase[] = [
  conformanceCase(
    "conforms: preserves arbitrary bytes through streamed snapshots",
    async (factory) => {
      const fileSystem = await factory();
      const original = Uint8Array.of(0, 0xff, 0x80, 0x0a, 0);
      await fileSystem.writeFile(
        "/bytes",
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of original) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      );
      const snapshot = await fileSystem.readFile("/bytes");
      await fileSystem.writeFile("/bytes", Uint8Array.of(9));

      expect([...(await readAllBytes(snapshot.stream, 16))]).toEqual([...original]);
      expect([...(await readAllBytes((await fileSystem.readFile("/bytes")).stream, 16))]).toEqual([
        9,
      ]);
    },
  ),
  conformanceCase(
    "conforms: reads clamped byte ranges while preserving full-file metadata",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/ranged", Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7));

      const middle = await fileSystem.readFile("/ranged", { range: { offset: 2, length: 3 } });
      expect(middle.stat.sizeBytes).toBe(8);
      expect([...(await readAllBytes(middle.stream, 8))]).toEqual([2, 3, 4]);

      const suffix = await fileSystem.readFile("/ranged", { range: { suffix: 3 } });
      expect([...(await readAllBytes(suffix.stream, 8))]).toEqual([5, 6, 7]);

      const throughEof = await fileSystem.readFile("/ranged", { range: { offset: 6 } });
      expect([...(await readAllBytes(throughEof.stream, 8))]).toEqual([6, 7]);

      const pastEof = await fileSystem.readFile("/ranged", { range: { offset: 99, length: 4 } });
      expect([...(await readAllBytes(pastEof.stream, 8))]).toEqual([]);
    },
  ),
  conformanceCase("conforms: rejects malformed byte ranges", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/ranged", "body");

    for (const range of [
      {},
      { length: 0 },
      { suffix: 0 },
      { offset: -1 },
      { offset: 0, suffix: 1 },
      { offset: 0, unexpected: 1 },
    ]) {
      await expect(
        (async () => fileSystem.readFile("/ranged", { range } as never))(),
      ).rejects.toMatchObject({ code: "EINVAL" });
    }
  }),
  conformanceCase(
    "conforms: digests the current byte snapshot and follows symbolic links",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/body", "body");
      await fileSystem.symlink("/link", "/body");

      const initial = "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5";
      expect(await fileSystem.digestFile("/body")).toBe(initial);
      expect(await fileSystem.digestFile("/link")).toBe(initial);
      expect(await fileSystem.digestFile("/body")).toBe(initial);

      await fileSystem.writeFile("/body", "BODY");
      const replaced = await fileSystem.digestFile("/body");
      expect(replaced).not.toBe(initial);
      expect(await fileSystem.digestFile("/body")).toBe(replaced);

      await fileSystem.writeFile("/empty", "");
      expect(await fileSystem.digestFile("/empty")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      await fileSystem.mkdir("/directory");
      expect(await refusal(() => fileSystem.digestFile("/directory"))).toMatchObject({
        code: "EISDIR",
      });
    },
  ),
  conformanceCase(
    "conforms: keeps a streamed create absent until the complete body is published",
    async (factory) => {
      const fileSystem = await factory();
      const body = gatedBody("complete");
      const writing = fileSystem.writeFile("/streamed-create", body.stream);
      await body.pulled;

      try {
        expect((await fileSystem.list("/")).map((entry) => entry.path)).not.toContain(
          "/streamed-create",
        );
      } finally {
        body.close();
        await writing;
      }
      expect(await readText(fileSystem, "/streamed-create")).toBe("complete");
    },
  ),
  conformanceCase(
    "conforms: keeps the previous generation visible until a streamed replacement closes",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/streamed-replace", "old");
      const body = gatedBody("new");
      const writing = fileSystem.writeFile("/streamed-replace", body.stream);
      await body.pulled;

      try {
        expect(await readText(fileSystem, "/streamed-replace")).toBe("old");
      } finally {
        body.close();
        await writing;
      }
      expect(await readText(fileSystem, "/streamed-replace")).toBe("new");
    },
  ),
  optionalConformanceCase(
    "failedInputStreams",
    "conforms: publishes no partial generation when an input stream fails",
    async (factory) => {
      const fileSystem = await factory();
      await expect(
        fileSystem.writeFile("/failed-create", streamThatFailsAfter("partial")),
      ).rejects.toThrow("source failed");
      expect((await fileSystem.list("/")).map((entry) => entry.path)).not.toContain(
        "/failed-create",
      );

      await fileSystem.writeFile("/failed-replace", "old");
      await expect(
        fileSystem.writeFile("/failed-replace", streamThatFailsAfter("partial")),
      ).rejects.toThrow("source failed");
      expect(await readText(fileSystem, "/failed-replace")).toBe("old");
    },
  ),
  conformanceCase(
    "conforms: accepts the current mutation token and publishes a new one",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/guarded", "old");
      const token = await fileSystem.getMutationToken("/guarded");
      const result = await fileSystem.writeFile("/guarded", "new", { ifMutationToken: token });
      expect(result.mutationToken).not.toBe(token);
      expect(
        new TextDecoder().decode(
          await readAllBytes((await fileSystem.readFile("/guarded")).stream, 16),
        ),
      ).toBe("new");
    },
  ),
  conformanceCase(
    "conforms: keeps an entry's identity through a move and a rewrite",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/src/file.txt", "one", { createParents: true });
      const created = (await fileSystem.stat("/src/file.txt")).ino;
      expect(created).toBeGreaterThan(0);

      await fileSystem.writeFile("/src/file.txt", "two");
      expect((await fileSystem.stat("/src/file.txt")).ino).toBe(created);

      fileSystem.setMetadata("/src/file.txt", { mode: 0o600 });
      expect((await fileSystem.stat("/src/file.txt")).ino).toBe(created);

      // A move renames the path and leaves the entry alone, so what a caller
      // keyed to the identity still names the same file.
      await fileSystem.move("/src", "/lib");
      expect((await fileSystem.stat("/lib/file.txt")).ino).toBe(created);
    },
  ),
  conformanceCase(
    "conforms: reports a missing move source before checking its destination",
    async (factory) => {
      const fileSystem = await factory();

      expect(await refusal(() => fileSystem.move("/missing", "/missing/child"))).toMatchObject({
        code: "ENOENT",
        path: "/missing",
      });
    },
  ),
  conformanceCase(
    "conforms: refuses a same-path move when the source is missing",
    async (factory) => {
      const fileSystem = await factory();

      expect(await refusal(() => fileSystem.move("/missing", "/missing"))).toMatchObject({
        code: "ENOENT",
        path: "/missing",
      });
    },
  ),
  conformanceCase(
    "conforms: reports a missing source before a same-path copy conflict",
    async (factory) => {
      const fileSystem = await factory();

      expect(await refusal(() => fileSystem.copy("/missing", "/missing"))).toMatchObject({
        code: "ENOENT",
        path: "/missing",
      });
    },
  ),
  conformanceCase("conforms: never hands an identity out again", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/a", "x");
    await fileSystem.writeFile("/b", "x");
    const removed = (await fileSystem.stat("/b")).ino;

    // Removing the newest entry is the case a bare rowid would recycle.
    await fileSystem.remove("/b");
    await fileSystem.writeFile("/c", "x");
    const replacement = (await fileSystem.stat("/c")).ino;
    expect(replacement).not.toBe(removed);
    expect(replacement).toBeGreaterThan(removed);

    // And recreating the same path is a new entry, not the old one returning.
    await fileSystem.writeFile("/b", "x");
    expect((await fileSystem.stat("/b")).ino).not.toBe(removed);
  }),
  conformanceCase(
    "conforms: makes the three ways of replacing content agree on identity",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/source", "source");
      await fileSystem.writeFile("/target", "one");
      const target = (await fileSystem.stat("/target")).ino;

      // Rewriting through the namespace keeps the entry.
      await fileSystem.writeFile("/target", "two");
      expect((await fileSystem.stat("/target")).ino).toBe(target);

      // So does copying one file over it. `cp` opens the destination and writes
      // through it; unlinking first is what `--remove-destination` is for, and
      // `cp x y` and `cat x > y` should not differ here.
      await fileSystem.copy("/source", "/target", { replace: true });
      expect((await fileSystem.stat("/target")).ino).toBe(target);
      expect(await readText(fileSystem, "/target")).toBe("source");

      // A move is the one that ends it, because the destination is gone and the
      // source is what is now there.
      await fileSystem.writeFile("/moved", "moved");
      const moved = (await fileSystem.stat("/moved")).ino;
      await fileSystem.move("/moved", "/target", { replace: true });
      expect((await fileSystem.stat("/target")).ino).toBe(moved);
    },
  ),
  conformanceCase(
    "conforms: preserves nothing when the destination is not a file",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/from/inner/file", "x", { createParents: true });
      await fileSystem.mkdir("/onto");
      const replaced = (await fileSystem.stat("/onto")).ino;

      // Only a file whose content was rewritten keeps its identity. A directory
      // being replaced is not that, so the copy issues new ones — and a
      // non-empty directory cannot be replaced at all, which is why this is the
      // reachable shape of the case.
      await fileSystem.copy("/from", "/onto", { recursive: true, replace: true });
      expect((await fileSystem.stat("/onto")).ino).not.toBe(replaced);
      expect(await readText(fileSystem, "/onto/inner/file")).toBe("x");
    },
  ),
  conformanceCase("conforms: gives every copied entry an identity of its own", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.mkdir("/tree/inner", true);
    for (let index = 0; index < 4; index += 1) {
      await fileSystem.writeFile(`/tree/inner/f${index}`, "x");
    }
    const before = (await fileSystem.find({ path: "/tree" })).map((entry) => entry.ino);

    await fileSystem.copy("/tree", "/copy", { recursive: true });
    const copied = (await fileSystem.find({ path: "/copy" })).map((entry) => entry.ino);

    expect(copied).toHaveLength(before.length);
    expect(new Set(copied).size).toBe(copied.length);
    // A copy is a different file, so it shares no identity with its source.
    for (const ino of copied) expect(before).not.toContain(ino);
  }),
  conformanceCase(
    "conforms: finds an entry that moved out from under a held identity",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.mkdir("/from/inner", true);
      await fileSystem.writeFile("/from/inner/doc", "body");
      const held = (await fileSystem.stat("/from/inner/doc")).ino;

      await fileSystem.move("/from", "/to");

      // What a host holding an identity could not do before: turn it back into
      // a path without an index of its own to keep in step.
      const found = await fileSystem.statById(held);
      expect(found.path).toBe("/to/inner/doc");
      expect(found.ino).toBe(held);
      expect(await readText(fileSystem, found.path)).toBe("body");
    },
  ),
  conformanceCase(
    "conforms: reports the entry itself rather than what it points at",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/target", "body");
      await fileSystem.symlink("/link", "/target");
      const link = await fileSystem.lstat("/link");

      // An identity names a row, so there is nothing to resolve through.
      const found = await fileSystem.statById(link.ino);
      expect(found).toMatchObject({ path: "/link", kind: "symlink", linkTarget: "/target" });
      expect(found.ino).not.toBe((await fileSystem.stat("/target")).ino);
    },
  ),
  conformanceCase("conforms: refuses an identity no entry holds", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/doc", "body");
    const removed = (await fileSystem.stat("/doc")).ino;
    await fileSystem.remove("/doc");

    // Permanent rather than momentary: an identity is never reissued, so a
    // host can retire what it keyed to this one instead of retrying.
    expect(await refusal(async () => fileSystem.statById(removed))).toMatchObject({
      code: "ENOENT",
    });
    await fileSystem.writeFile("/doc", "again");
    expect(await refusal(async () => fileSystem.statById(removed))).toMatchObject({
      code: "ENOENT",
    });
  }),
  conformanceCase("conforms: refuses an identity that was never issuable", async (factory) => {
    const fileSystem = await factory();
    // Zero is the documented sentinel for a path answered above the
    // namespace, so it must not read as "an entry that is gone".
    for (const candidate of [0, -1, 1.5]) {
      expect(await refusal(async () => fileSystem.statById(candidate))).toMatchObject({
        code: "EINVAL",
      });
    }
  }),
];
