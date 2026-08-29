import { expect } from "vitest";
import {
  conformanceCase,
  readText,
  refusal,
  type VfsConformanceCase,
} from "./vfs-conformance-support.js";

export const BATCH_CONFORMANCE: readonly VfsConformanceCase[] = [
  conformanceCase("conforms: publishes a set of bodies as one change", async (factory) => {
    const fileSystem = await factory();
    const written = await fileSystem.writeFiles(
      [
        { path: "/set/a", body: "a" },
        { path: "/set/b", body: "b" },
        { path: "/set/c", body: "c" },
      ],
      { createParents: true },
    );

    expect(written.map((result) => result.path)).toEqual(["/set/a", "/set/b", "/set/c"]);
    expect(written.every((result) => result.created)).toBe(true);
    // Every path publishes a revision and a token of its own. The token
    // strings can coincide -- it composes the epoch with a path's version,
    // and three fresh paths all reach version one -- but each is the token
    // that path now reports, which is what a caller guards on next.
    expect(written.map((result) => result.revision)).toEqual([1, 1, 1]);
    expect([
      await readText(fileSystem, "/set/a"),
      await readText(fileSystem, "/set/b"),
      await readText(fileSystem, "/set/c"),
    ]).toEqual(["a", "b", "c"]);
    for (const result of written) {
      expect((await fileSystem.stat(result.path)).mutationToken).toBe(result.mutationToken);
    }
  }),
  conformanceCase(
    "conforms: leaves every path as it was when a later entry refuses",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/batch/first", "original", { createParents: true });
      await fileSystem.writeFile("/batch/second", "original");
      const first = await fileSystem.stat("/batch/first");
      const stale = await fileSystem.getMutationToken("/batch/second");
      await fileSystem.writeFile("/batch/second", "moved");

      const refused = await refusal(() =>
        fileSystem.writeFiles([
          { path: "/batch/first", body: "replacement" },
          { path: "/batch/second", body: "replacement", ifMutationToken: stale },
          { path: "/batch/third", body: "replacement" },
        ]),
      );

      expect(refused).toMatchObject({ code: "EREVISION", path: "/batch/second" });
      // The entry before the failure is the one a sequence of writes would
      // already have changed. It is what the batch exists to protect.
      expect(await readText(fileSystem, "/batch/first")).toBe("original");
      expect(await fileSystem.stat("/batch/first")).toMatchObject({
        revision: first.revision,
        mutationToken: first.mutationToken,
      });
      expect(await readText(fileSystem, "/batch/second")).toBe("moved");
      expect((await fileSystem.list("/batch")).map((entry) => entry.path)).toEqual([
        "/batch/first",
        "/batch/second",
      ]);
    },
  ),
  conformanceCase(
    "conforms: creates nothing when an entry in the set is a directory",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.mkdir("/occupied", true);

      const refused = await refusal(() =>
        fileSystem.writeFiles([
          { path: "/fresh-one", body: "one" },
          { path: "/occupied", body: "two" },
        ]),
      );

      expect(refused).toMatchObject({ code: "EISDIR", path: "/occupied" });
      expect((await fileSystem.list("/")).map((entry) => entry.path)).not.toContain("/fresh-one");
    },
  ),
  conformanceCase(
    "conforms: refuses a batch that names one path more than once",
    async (factory) => {
      const fileSystem = await factory();
      const refused = await refusal(() =>
        fileSystem.writeFiles([
          { path: "/twice", body: "one" },
          { path: "/./twice", body: "two" },
        ]),
      );

      // Neither body is the answer, so neither is written.
      expect(refused).toMatchObject({ code: "EINVAL", path: "/twice" });
      expect((await fileSystem.list("/")).map((entry) => entry.path)).not.toContain("/twice");
    },
  ),
  conformanceCase(
    "conforms: reports the revision already in force for a matched skip",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/skip/same", "body", { createParents: true });
      await fileSystem.writeFile("/skip/other", "before");
      const settled = await fileSystem.stat("/skip/same");

      const written = await fileSystem.writeFiles(
        [
          { path: "/skip/same", body: "body" },
          { path: "/skip/other", body: "after" },
        ],
        { skipIfUnchanged: true },
      );

      expect(written[0]).toMatchObject({
        revision: settled.revision,
        mutationToken: settled.mutationToken,
        created: false,
      });
      // A skipped entry keeps its timestamp; the entry beside it still writes.
      expect(await fileSystem.stat("/skip/same")).toMatchObject({
        modifiedAtMs: settled.modifiedAtMs,
        revision: settled.revision,
      });
      expect(written[1]?.revision).toBe(2);
      expect(await readText(fileSystem, "/skip/other")).toBe("after");
    },
  ),
  conformanceCase(
    "conforms: guards every entry against the token it was read at",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/guarded/a", "a", { createParents: true });
      await fileSystem.writeFile("/guarded/b", "b");

      const written = await fileSystem.writeFiles([
        {
          path: "/guarded/a",
          body: "a2",
          ifMutationToken: await fileSystem.getMutationToken("/guarded/a"),
        },
        {
          path: "/guarded/b",
          body: "b2",
          ifMutationToken: await fileSystem.getMutationToken("/guarded/b"),
        },
      ]);

      expect(written.map((result) => result.revision)).toEqual([2, 2]);
      expect([
        await readText(fileSystem, "/guarded/a"),
        await readText(fileSystem, "/guarded/b"),
      ]).toEqual(["a2", "b2"]);
    },
  ),
  conformanceCase("conforms: writes nothing for an empty set", async (factory) => {
    const fileSystem = await factory();
    expect(await fileSystem.writeFiles([])).toEqual([]);
  }),
  conformanceCase(
    "conforms: applies namespace operations and paginated traversal consistently",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.mkdir("/tree", true);
      await fileSystem.writeFile("/tree/a", "a");
      await fileSystem.copy("/tree/a", "/tree/b");
      await fileSystem.move("/tree/b", "/tree/c");

      const first = await fileSystem.listPage("/tree", { limit: 1 });
      expect(first.entries).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      if (first.nextCursor === null) throw new Error("expected a second conformance page");
      const second = await fileSystem.listPage("/tree", {
        cursor: first.nextCursor,
        limit: 1,
      });
      expect([...first.entries, ...second.entries].map((entry) => entry.path)).toEqual([
        "/tree/a",
        "/tree/c",
      ]);
      expect(
        (
          await fileSystem.listPage("/tree", { cursor: "/tree/a/descendant", limit: 1 })
        ).entries.map((entry) => entry.path),
      ).toEqual(["/tree/c"]);

      expect(await fileSystem.remove("/tree", { recursive: true })).toMatchObject({ removed: 3 });
      expect((await fileSystem.list("/")).map((entry) => entry.path)).not.toContain("/tree");
    },
  ),
];
