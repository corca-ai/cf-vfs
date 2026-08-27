import { describe, expect, it } from "vitest";
import type { VfsError } from "../src/core/errors.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import type { VfsEvent } from "../src/vfs/events.js";
import { putOpaque, readOpaque } from "../src/vfs/opaque.js";
import { readAllBytes, streamFromChunks } from "../src/vfs/streams.js";
import type { OpaqueObjectMetadata, OpaqueStore } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";
import { runVfsConformance } from "./helpers/vfs-conformance.js";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...(await readAllBytes(stream, 16 * 1024 * 1024))];
}

describe("byte-oriented in-memory SQLite filesystem", () => {
  it("creates byte streams that support BYOB readers", async () => {
    const reader = streamFromChunks([Uint8Array.of(1, 2, 3)]).getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(3));
    expect(first.done).toBe(false);
    expect([...(first.value ?? new Uint8Array())]).toEqual([1, 2, 3]);
    await reader.cancel();
  });

  describe("shared VFS conformance", () => {
    runVfsConformance(() => createTestFileSystem());
  });

  describe("observability", () => {
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

      await expect(
        fileSystem.writeFile("/b/c", "x", { createParents: true }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
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

    describe("limits read on every check", () => {
      it("refuses and admits by whatever the limit says now", async () => {
        let maxEntries = 2;
        const fileSystem = createTestFileSystem({ maxEntries: () => maxEntries });

        // The root directory counts, so this fills the workspace.
        await fileSystem.writeFile("/a", "x");
        await expect(fileSystem.writeFile("/b", "x")).rejects.toMatchObject({
          code: "ENOSPC",
        });

        // No new construction, no eviction: the host answered differently and
        // the next check saw it.
        maxEntries = 3;
        expect(await fileSystem.writeFile("/b", "x")).toMatchObject({ created: true });

        maxEntries = 2;
        await expect(fileSystem.writeFile("/c", "x")).rejects.toMatchObject({
          code: "ENOSPC",
        });
      });

      it("reports the value in force when it refuses", async () => {
        const events: VfsEvent[] = [];
        let maxInlineLogicalBytes = 8;
        const fileSystem = createTestFileSystem({
          maxInlineLogicalBytes: () => maxInlineLogicalBytes,
          onEvent: (event) => events.push(event),
        });

        await expect(fileSystem.writeFile("/a", "123456789")).rejects.toMatchObject({
          code: "ENOSPC",
        });
        expect(events).toContainEqual({
          type: "vfs.quota",
          limit: "maxInlineLogicalBytes",
          requested: 9,
          used: 0,
          max: 8,
          path: "/a",
        });

        maxInlineLogicalBytes = 4;
        await expect(fileSystem.writeFile("/a", "123456789")).rejects.toMatchObject({
          code: "ENOSPC",
        });
        expect(events.at(-1)).toMatchObject({ max: 4 });
      });

      // A quota that silently stops applying is worse than one that refuses,
      // so a limit that comes back unusable fails the mutation instead.
      it("fails the mutation when the limit comes back unusable", async () => {
        for (const bad of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
          const fileSystem = createTestFileSystem({ maxEntries: () => bad });
          await expect(fileSystem.writeFile("/a", "x")).rejects.toMatchObject({
            code: "EINVAL",
            message: "maxEntries must be a positive safe integer",
          });
        }
      });

      it("still validates a fixed limit once, at construction", () => {
        expect(() => createTestFileSystem({ maxEntries: 0 })).toThrow(
          "maxEntries must be a positive safe integer",
        );
        expect(() => createTestFileSystem({ maxInlineLogicalBytes: -1 })).toThrow(
          "maxInlineLogicalBytes must be a positive safe integer",
        );
        // A function is not called until a check needs it, so an unusable one
        // does not stop the workspace from opening.
        expect(() => createTestFileSystem({ maxEntries: () => 0 })).not.toThrow();
      });

      // Reachable the moment a limit can move, and reachable already for a host
      // that lowers one in its own source and deploys.
      describe("with usage already past the limit", () => {
        async function overLimit(): Promise<ReturnType<typeof createTestFileSystem>> {
          let maxEntries = 100;
          const fileSystem = createTestFileSystem({ maxEntries: () => maxEntries });
          for (let index = 0; index < 5; index += 1) {
            await fileSystem.writeFile(`/f${index}`, "xxx");
          }
          maxEntries = 2;
          return fileSystem;
        }

        it("lets the workspace write less", async () => {
          const fileSystem = await overLimit();
          // Both hold the entry count steady, and one gives bytes back. The end
          // state is no further past the limit than the start, so refusing them
          // would only keep the workspace there.
          expect(await fileSystem.writeFile("/f0", "yyy")).toMatchObject({ created: false });
          expect(await fileSystem.writeFile("/f0", "")).toMatchObject({ created: false });
          expect(await fileSystem.remove("/f1")).toMatchObject({ removed: 1 });
          expect(await fileSystem.move("/f2", "/moved")).toMatchObject({ moved: 1 });
        });

        it("still refuses growth", async () => {
          const fileSystem = await overLimit();
          await expect(fileSystem.writeFile("/new", "x")).rejects.toMatchObject({
            code: "ENOSPC",
          });
          expect(() => fileSystem.mkdir("/dir")).toThrow("filesystem entry quota exceeded");
          await expect(fileSystem.copy("/f0", "/copied")).rejects.toMatchObject({
            code: "ENOSPC",
          });
        });

        it("refuses bytes it would add even while the entry count holds", async () => {
          let maxInlineLogicalBytes = 100;
          const fileSystem = createTestFileSystem({
            maxInlineLogicalBytes: () => maxInlineLogicalBytes,
          });
          await fileSystem.writeFile("/f", "x".repeat(50));
          maxInlineLogicalBytes = 10;

          await expect(fileSystem.writeFile("/f", "x".repeat(60))).rejects.toMatchObject({
            code: "ENOSPC",
          });
          await expect(fileSystem.appendFile("/f", "x")).rejects.toMatchObject({
            code: "ENOSPC",
          });
          expect(await fileSystem.writeFile("/f", "x".repeat(50))).toMatchObject({
            created: false,
          });
          expect(await fileSystem.writeFile("/f", "x")).toMatchObject({ created: false });
        });
      });
    });

    describe("usage accounting", () => {
      type Usage = { inlineBytes: number; entries: number };

      function metered(options: Parameters<typeof createTestFileSystem>[0] = {}): {
        fileSystem: ReturnType<typeof createTestFileSystem>;
        usage: () => Usage | undefined;
      } {
        let last: Usage | undefined;
        const fileSystem = createTestFileSystem({
          ...options,
          onEvent: (event) => {
            if (event.type === "vfs.usage") {
              last = { inlineBytes: event.inlineBytes, entries: event.entries };
            }
          },
        });
        return { fileSystem, usage: () => last };
      }

      // The oracle for every case below: the same end state, built without a
      // replacement. What a replacing copy reports has to match it, because
      // the two filesystems hold the same entries and the same bytes.
      it("reports the same totals for a replacing copy as for the tree built directly", async () => {
        const replaced = metered();
        await replaced.fileSystem.writeFile("/ballast", "z".repeat(1000));
        await replaced.fileSystem.writeFile("/a", "abc");
        await replaced.fileSystem.writeFile("/b", "x".repeat(100));
        await replaced.fileSystem.copy("/a", "/b", { replace: true });

        const direct = metered();
        await direct.fileSystem.writeFile("/ballast", "z".repeat(1000));
        await direct.fileSystem.writeFile("/a", "abc");
        await direct.fileSystem.writeFile("/b", "abc");

        expect(replaced.usage()).toEqual({ inlineBytes: 1006, entries: 4 });
        expect(replaced.usage()).toEqual(direct.usage());
      });

      it("reports the same totals for a replacing recursive copy", async () => {
        const replaced = metered();
        await replaced.fileSystem.mkdir("/src");
        await replaced.fileSystem.writeFile("/src/f", "hello");
        await replaced.fileSystem.mkdir("/dst");
        await replaced.fileSystem.copy("/src", "/dst", { replace: true, recursive: true });

        const direct = metered();
        await direct.fileSystem.mkdir("/src");
        await direct.fileSystem.writeFile("/src/f", "hello");
        await direct.fileSystem.mkdir("/dst");
        await direct.fileSystem.writeFile("/dst/f", "hello");

        expect(replaced.usage()).toEqual({ inlineBytes: 10, entries: 5 });
        expect(replaced.usage()).toEqual(direct.usage());
      });

      it("reports the same totals when the copy grows the destination", async () => {
        const { fileSystem, usage } = metered();
        await fileSystem.writeFile("/a", "x".repeat(100));
        await fileSystem.writeFile("/b", "abc");
        await fileSystem.copy("/a", "/b", { replace: true });
        expect(usage()).toEqual({ inlineBytes: 200, entries: 3 });
      });

      // A wrong counter is not just a wrong number: it is quota headroom that
      // an ordinary sequence of operations can manufacture. Each replacing
      // copy used to give one entry back, so repeating it walked the stored
      // total down and let the tree grow past the limit that refuses work.
      it("does not let repeated replacing copies buy quota headroom", async () => {
        const { fileSystem } = metered({ maxEntries: 12 });
        await fileSystem.mkdir("/d");
        for (let index = 0; index < 8; index += 1) {
          await fileSystem.writeFile(`/d/f${index}`, "a");
        }
        for (let index = 0; index < 8; index += 1) {
          await fileSystem.copy("/d/f0", "/d/f1", { replace: true });
        }

        let created = 0;
        for (let index = 0; index < 20; index += 1) {
          const failed = await fileSystem.writeFile(`/d/extra${index}`, "a").then(
            () => null,
            (error: unknown) => error,
          );
          if (failed !== null) {
            expect(failed).toMatchObject({ code: "ENOSPC" });
            break;
          }
          created += 1;
        }

        expect(await fileSystem.find({ path: "/" })).toHaveLength(12 - 1);
        expect(created).toBe(2);
      });
    });

    describe("mutation notification", () => {
      function observed(options: Parameters<typeof createTestFileSystem>[0] = {}) {
        const mutations: Extract<VfsEvent, { type: "vfs.mutation" }>[] = [];
        const fileSystem = createTestFileSystem({
          ...options,
          onEvent: (event) => {
            if (event.type === "vfs.mutation") mutations.push(event);
          },
        });
        return { fileSystem, mutations };
      }

      it("names what each single-path change did", async () => {
        const { fileSystem, mutations } = observed();
        const created = await fileSystem.writeFile("/file", "one");
        await fileSystem.writeFile("/file", "two");
        fileSystem.setMetadata("/file", { mode: 0o600 });
        fileSystem.symlink("/link", "/file");
        await fileSystem.remove("/file");

        expect(mutations).toEqual([
          {
            type: "vfs.mutation",
            op: "create",
            path: "/file",
            mutationToken: created.mutationToken,
          },
          { type: "vfs.mutation", op: "write", path: "/file", mutationToken: expect.any(String) },
          {
            type: "vfs.mutation",
            op: "metadata",
            path: "/file",
            mutationToken: expect.any(String),
          },
          { type: "vfs.mutation", op: "create", path: "/link", mutationToken: expect.any(String) },
          { type: "vfs.mutation", op: "remove", path: "/file" },
        ]);
      });

      it("carries the token the writer already holds, so a writer knows its own", async () => {
        const { fileSystem, mutations } = observed();
        const result = await fileSystem.writeFile("/file", "body");
        // This is what makes a writer/origin field unnecessary: the token the
        // call returned is the token the notification carries.
        expect(mutations.at(0)).toMatchObject({ mutationToken: result.mutationToken });
      });

      it("reports every directory a create had to make", async () => {
        const { fileSystem, mutations } = observed();
        await fileSystem.writeFile("/a/b/file", "body", { createParents: true });
        expect(mutations.map((event) => [event.op, event.path])).toEqual([
          ["create", "/a"],
          ["create", "/a/b"],
          ["create", "/a/b/file"],
        ]);
      });

      it("reports a range for a set-based change rather than one path per entry", async () => {
        const { fileSystem, mutations } = observed();
        await fileSystem.mkdir("/tree/inner", true);
        for (let index = 0; index < 20; index += 1) {
          await fileSystem.writeFile(`/tree/inner/f${index}`, "x");
        }
        mutations.length = 0;

        await fileSystem.copy("/tree", "/copy", { recursive: true });
        await fileSystem.move("/tree", "/moved");
        await fileSystem.remove("/moved", { recursive: true });

        // Twenty-two entries in each case, one notification each.
        expect(mutations).toEqual([
          { type: "vfs.mutation", op: "create", path: "/copy", subtree: { root: "/copy" } },
          {
            type: "vfs.mutation",
            op: "move",
            path: "/tree",
            subtree: { root: "/tree", to: "/moved" },
          },
          { type: "vfs.mutation", op: "remove", path: "/moved", subtree: { root: "/moved" } },
        ]);
      });

      it("omits the range when only one entry was involved", async () => {
        const { fileSystem, mutations } = observed();
        await fileSystem.writeFile("/only", "x");
        mutations.length = 0;
        await fileSystem.copy("/only", "/copy");
        await fileSystem.remove("/copy");
        for (const event of mutations) expect(event).not.toHaveProperty("subtree");
      });

      it("announces nothing when the transaction rolled back", async () => {
        const { fileSystem, mutations } = observed({ maxEntries: 2 });
        await fileSystem.writeFile("/first", "x");
        mutations.length = 0;
        await expect(
          fileSystem.writeFile("/second/third", "x", { createParents: true }),
        ).rejects.toMatchObject({ code: "ENOSPC" });
        // The parent directory was created inside the transaction that then
        // failed, so reporting it would announce a directory that is not there.
        expect(mutations).toEqual([]);
        expect(() => fileSystem.stat("/second")).toThrow();
      });

      it("catches a caller up on what changed while it was away", async () => {
        const fileSystem = createTestFileSystem({ recordChanges: true });
        await fileSystem.writeFile("/a", "one");
        await fileSystem.writeFile("/b", "two");
        const seen = fileSystem.changesSince(0).cursor;

        await fileSystem.writeFile("/a", "changed");
        await fileSystem.writeFile("/c", "new");
        await fileSystem.remove("/b");

        const page = fileSystem.changesSince(seen);
        expect(page.more).toBe(false);
        expect(page.changes).toEqual([
          { path: "/a", present: true },
          { path: "/c", present: true },
          { path: "/b", present: false },
        ]);
        // Resuming from the reported cursor reports nothing further, and the
        // cursor stands still rather than rewinding.
        const quiet = fileSystem.changesSince(page.cursor);
        expect(quiet.changes).toEqual([]);
        expect(quiet.cursor).toBe(page.cursor);
      });

      it("reports from zero only what changed after recording began", async () => {
        const fileSystem = createTestFileSystem({ recordChanges: true });
        await fileSystem.writeFile("/a/b", "x", { createParents: true });
        const paths = fileSystem.changesSince(0).changes.map((change) => change.path);
        expect(paths).toEqual(["/a", "/a/b"]);
        // The root predates the cursor and is not reported, which is why a
        // caller takes a cursor first and then reads the namespace: anything
        // that changes during that read is replayed from the cursor.
        expect(paths).not.toContain("/");
      });

      it("collapses repeated changes to one entry per path", async () => {
        const fileSystem = createTestFileSystem({ recordChanges: true });
        await fileSystem.writeFile("/a", "one");
        const seen = fileSystem.changesSince(0).cursor;
        for (let index = 0; index < 5; index += 1) {
          await fileSystem.writeFile("/a", `body ${index}`);
        }
        expect(fileSystem.changesSince(seen).changes).toEqual([{ path: "/a", present: true }]);
      });

      it("gives every path a set-based change the same sequence", async () => {
        const fileSystem = createTestFileSystem({ recordChanges: true });
        await fileSystem.mkdir("/tree/inner", true);
        for (let index = 0; index < 4; index += 1) {
          await fileSystem.writeFile(`/tree/inner/f${index}`, "x");
        }
        const seen = fileSystem.changesSince(0).cursor;

        await fileSystem.move("/tree", "/moved");
        const page = fileSystem.changesSince(seen);
        // Six paths gone and six arrived, and a caller can take the whole move
        // as one step because the sequence does not split it.
        expect(page.changes.filter((change) => !change.present).map((c) => c.path)).toEqual([
          "/tree",
          "/tree/inner",
          "/tree/inner/f0",
          "/tree/inner/f1",
          "/tree/inner/f2",
          "/tree/inner/f3",
        ]);
        expect(page.changes.filter((change) => change.present).map((c) => c.path)).toEqual([
          "/moved",
          "/moved/inner",
          "/moved/inner/f0",
          "/moved/inner/f1",
          "/moved/inner/f2",
          "/moved/inner/f3",
        ]);
      });

      it("pages a large catch-up rather than materializing it", async () => {
        const fileSystem = createTestFileSystem({ recordChanges: true });
        for (let index = 0; index < 30; index += 1) {
          await fileSystem.writeFile(`/f${index}`, "x");
        }
        const collected: string[] = [];
        let cursor = 0;
        for (;;) {
          const page = fileSystem.changesSince(cursor, { limit: 7 });
          collected.push(...page.changes.map((change) => change.path));
          cursor = page.cursor;
          if (!page.more) break;
        }
        expect(collected).toHaveLength(30);
        expect(new Set(collected).size).toBe(30);
      });

      it("refuses the feed when it was not enabled, and to a bound view", async () => {
        const off = createTestFileSystem();
        expect(() => off.changesSince(0)).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }) as Error,
        );

        const on = createTestFileSystem({ recordChanges: true });
        expect(() => on.forCredentials({ uid: 1000, gid: 1000 }).changesSince(0)).toThrow(
          expect.objectContaining({ code: "EPERM" }) as Error,
        );
        expect(() => on.changesSince(-1)).toThrow(
          expect.objectContaining({ code: "EINVAL" }) as Error,
        );
      });
    });

    describe("reading by entry identity", () => {
      it("refuses a credential-bound view, whatever the identity holds", async () => {
        const fileSystem = createTestFileSystem();
        fileSystem.mkdir("/private", true);
        await fileSystem.writeFile("/private/secret", "body");
        await fileSystem.writeFile("/readable", "body");
        fileSystem.setMetadata("/private", { mode: 0o040700 });

        const view = fileSystem.forCredentials({ uid: 1000, gid: 1000 });
        const unreachable = fileSystem.stat("/private/secret").ino;
        const reachable = fileSystem.stat("/readable").ino;

        // Refused for an entry the caller could reach by path too. Answering
        // only for those would still hand out existence for the others by
        // which identities refuse, and identities are consecutive.
        for (const ino of [unreachable, reachable, 999_999]) {
          expect(() => view.statById(ino)).toThrow(
            expect.objectContaining({ code: "EPERM" }) as Error,
          );
        }
        // The trusted capability still answers, which is what makes the refusal
        // a boundary rather than the feature being absent.
        expect(fileSystem.statById(unreachable).path).toBe("/private/secret");
      });

      it("shows why the view cannot answer: identities are consecutive", async () => {
        const fileSystem = createTestFileSystem();
        fileSystem.mkdir("/a", true);
        for (let index = 0; index < 5; index += 1) {
          await fileSystem.writeFile(`/a/f${index}`, "x");
        }
        const census: string[] = [];
        for (let ino = 1; ino <= 8; ino += 1) {
          try {
            census.push(fileSystem.statById(ino).path);
          } catch {
            census.push("<none>");
          }
        }
        // Counting up from one enumerates the workspace, which is what a
        // credential-bound caller must not be able to do.
        expect(census).toEqual(["/", "/a", "/a/f0", "/a/f1", "/a/f2", "/a/f3", "/a/f4", "<none>"]);
      });
    });

    describe("mutation notification (continued)", () => {
      it("keeps a throwing observer from changing the mutation", async () => {
        const fileSystem = createTestFileSystem({
          onEvent: (event) => {
            if (event.type === "vfs.mutation") throw new Error("observer failed");
          },
        });
        await expect(fileSystem.writeFile("/file", "body")).resolves.toMatchObject({
          created: true,
        });
        expect(fileSystem.stat("/file").sizeBytes).toBe(4);
      });
    });
  });

  it("counts a subtree past the ceiling that truncates find()", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.mkdir("/bulk");
    for (let index = 0; index < 10_050; index += 1) {
      await fileSystem.writeFile(`/bulk/f${index}`, "x");
    }

    // find() materializes a VfsStat per entry and stops at its 10,000 default,
    // so it cannot be used to charge a mutation budget accurately.
    expect(fileSystem.find({ path: "/bulk", includeRoot: true })).toHaveLength(10_000);
    expect(fileSystem.countSubtree("/bulk")).toBe(10_051);
    // Writing past the find() ceiling is the point of this case, so it is
    // legitimately long: about two seconds locally and more on a shared CI
    // runner. The default five-second timeout is not enough headroom.
  }, 30_000);

  it("stores arbitrary bytes and gives active readers a bounded snapshot", async () => {
    const fileSystem = createTestFileSystem({ chunkBytes: 2 });
    await fileSystem.writeFile("/data", new Uint8Array([0xff, 0, 1, 2, 3]));

    const snapshot = fileSystem.readFile("/data");
    await fileSystem.writeFile("/data", new Uint8Array([9]));

    expect(await bytes(snapshot.stream)).toEqual([0xff, 0, 1, 2, 3]);
    expect(await bytes(fileSystem.readFile("/data").stream)).toEqual([9]);
  });

  it("does not publish a streaming write until close and rejects a concurrent path change", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/file", "old");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("new"));
        await gate;
        controller.close();
      },
    });

    const writing = fileSystem.writeFile("/file", body);
    await Promise.resolve();
    expect(
      new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/file").stream, 16)),
    ).toBe("old");

    fileSystem.touch("/file");
    release?.();
    await expect(writing).rejects.toMatchObject({ code: "EREVISION", path: "/file" });
  });

  it("keeps materialized read snapshots in the shared in-flight byte budget", async () => {
    const fileSystem = createTestFileSystem({
      maxInlineFileBytes: 4,
      maxInFlightBufferedBytes: 4,
    });
    await fileSystem.writeFile("/file", "1234");
    const first = fileSystem.readFile("/file");
    // The second snapshot fits the budget on its own and is refused only
    // because the first is holding it, which is what `EAGAIN` says and
    // `ENOSPC` would not: cancelling the first is all it takes.
    expect(() => fileSystem.readFile("/file")).toThrowError(
      expect.objectContaining({ code: "EAGAIN" }),
    );
    await first.stream.cancel();
    expect(await bytes(fileSystem.readFile("/file").stream)).toEqual([49, 50, 51, 52]);
  });

  it("shares the in-flight budget across concurrent streaming writes", async () => {
    const fileSystem = createTestFileSystem({
      maxInlineFileBytes: 8,
      maxInFlightBufferedBytes: 4,
    });
    let closeFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      closeFirst = resolve;
    });
    const first = fileSystem.writeFile(
      "/first",
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          await firstGate;
          controller.close();
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await expect(fileSystem.writeFile("/second", new Uint8Array([4, 5, 6]))).rejects.toMatchObject({
      code: "EAGAIN",
    });
    closeFirst?.();
    await first;
    // Retryable, and retried: the capacity the refusal wanted was only ever
    // held by a write that has since finished.
    await fileSystem.writeFile("/second", new Uint8Array([4, 5, 6]));
    expect(await bytes(fileSystem.readFile("/second").stream)).toEqual([4, 5, 6]);
  });

  it("discards a failed input stream without publishing partial bytes", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/file", "old");
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("new"));
        controller.error(new Error("source failed"));
      },
    });
    await expect(fileSystem.writeFile("/file", failed)).rejects.toThrow("source failed");
    expect(
      new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/file").stream, 16)),
    ).toBe("old");
  });

  it("enforces file, workspace, entry, and in-flight limits without partial mutation", async () => {
    const fileSystem = createTestFileSystem({
      maxInlineFileBytes: 4,
      maxInlineLogicalBytes: 6,
      maxEntries: 3,
      maxInFlightBufferedBytes: 4,
    });
    await fileSystem.writeFile("/a", "1234");
    await expect(fileSystem.writeFile("/a", "12345")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await bytes(fileSystem.readFile("/a").stream)).toEqual([49, 50, 51, 52]);

    await fileSystem.writeFile("/b", "12");
    await expect(fileSystem.writeFile("/c", "x")).rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("preflights recursive parent creation with the final entry quota", async () => {
    const fileSystem = createTestFileSystem({ maxEntries: 2 });

    await expect(
      fileSystem.writeFile("/parent/file", "x", { createParents: true }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(() => fileSystem.stat("/parent")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  describe("batched writes", () => {
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
});
