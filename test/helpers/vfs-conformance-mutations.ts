import { expect } from "vitest";
import { readAllBytes } from "../../src/vfs/streams.js";
import {
  conformanceCase,
  optionalConformanceCase,
  readText,
  refusal,
  type VfsConformanceCase,
} from "./vfs-conformance-support.js";

export const MUTATION_CONFORMANCE: readonly VfsConformanceCase[] = [
  ...(["move", "copy"] as const).map((operation) =>
    conformanceCase(
      `conforms: preserves non-BMP subtree paths during ${operation}`,
      async (factory) => {
        const fs = await factory();
        await fs.writeFile("/😀/nested/한글", "body", { createParents: true });
        if (operation === "move") await fs.move("/😀", "/dest");
        else await fs.copy("/😀", "/dest", { recursive: true });
        const stat = await fs.stat("/dest/nested/한글");
        expect(stat.parentPath).toBe("/dest/nested");
        expect(await readText(fs, stat.path)).toBe("body");
        await fs.writeFile(stat.path, "guarded", { ifMutationToken: stat.mutationToken });
        expect((await fs.list("/dest")).map((entry) => entry.path)).toEqual(["/dest/nested"]);
      },
    ),
  ),
  conformanceCase(
    "conforms: advances the revision when a copy replaces a file",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/other", "source");
      for (const body of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
        await fileSystem.writeFile("/doc", body);
      }
      const before = await fileSystem.stat("/doc");

      await fileSystem.copy("/other", "/doc", { replace: true });

      const after = await fileSystem.stat("/doc");
      // `cp x y` and `cat x > y` agree on this field, which is what a caller
      // keying durable state to an identity cannot be expected to hold apart.
      expect(after.ino).toBe(before.ino);
      expect(after.revision).toBe(before.revision + 1);
    },
  ),
  conformanceCase(
    "conforms: advances the revision when a move replaces a file",
    async (factory) => {
      const fileSystem = await factory();
      for (const body of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
        await fileSystem.writeFile("/b", body);
      }
      const before = await fileSystem.stat("/b");
      await fileSystem.writeFile("/a", "a1");
      await fileSystem.writeFile("/a", "a2");

      await fileSystem.move("/a", "/b", { replace: true });

      // The arriving entry brought a revision of its own, and the destination
      // had a higher one. The path takes one past the greater.
      const after = await fileSystem.stat("/b");
      expect(after.ino).not.toBe(before.ino);
      expect(after.revision).toBe(before.revision + 1);
    },
  ),
  conformanceCase(
    "conforms: advances the revision when a link replaces a file",
    async (factory) => {
      const fileSystem = await factory();
      for (const body of ["v1", "v2", "v3", "v4"]) await fileSystem.writeFile("/link", body);
      const before = await fileSystem.lstat("/link");
      await fileSystem.writeFile("/target", "t");

      const created = await fileSystem.symlink("/link", "/target", { replace: true });

      expect(created.revision).toBe(before.revision + 1);
      expect((await fileSystem.lstat("/link")).revision).toBe(before.revision + 1);
    },
  ),
  conformanceCase("conforms: starts at one wherever nothing was there", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/src", "x");
    await fileSystem.mkdir("/tree");
    await fileSystem.writeFile("/tree/f", "y");

    await fileSystem.copy("/src", "/fresh");
    await fileSystem.copy("/tree", "/copy", { recursive: true });
    await fileSystem.symlink("/fresh-link", "/src");

    // Only what lands on an occupied path is affected. A descendant of a
    // recursive copy always lands somewhere absent, because a non-empty
    // directory cannot be replaced at all.
    expect((await fileSystem.stat("/fresh")).revision).toBe(1);
    expect((await fileSystem.stat("/copy/f")).revision).toBe(1);
    expect((await fileSystem.lstat("/fresh-link")).revision).toBe(1);
  }),
  conformanceCase(
    "conforms: keeps (ino, revision) moving forward across a replacement",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/other", "source");
      const seen: string[] = [];
      const record = async () => {
        const stat = await fileSystem.stat("/doc");
        seen.push(`${stat.ino}:${stat.revision}`);
      };

      await fileSystem.writeFile("/doc", "v1");
      await record();
      for (const body of ["v2", "v3"]) {
        await fileSystem.writeFile("/doc", body);
        await record();
      }
      await fileSystem.copy("/other", "/doc", { replace: true });
      await record();
      await fileSystem.writeFile("/doc", "v5");
      await record();

      // One identity throughout, and a revision a cache can key on: the pair
      // is unique over the identity's lifetime rather than repeating.
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(
        seen
          .map((entry) => entry)
          .sort((left, right) => Number(left.split(":")[1]) - Number(right.split(":")[1])),
      );
    },
  ),
  conformanceCase("conforms: refuses a guard held across a replacing copy", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/other", "source");
    await fileSystem.writeFile("/doc", "v1");
    const held = await fileSystem.stat("/doc");
    for (const body of ["v2", "v3", "v4", "v5", "v6"]) {
      await fileSystem.writeFile("/doc", body);
    }
    await fileSystem.copy("/other", "/doc", { replace: true });

    // The destination keeps its identity and its revision returns to 1, so
    // the number a caller was holding matches what is on the row again.
    expect((await fileSystem.stat("/doc")).ino).toBe(held.ino);
    expect(
      await refusal(() =>
        fileSystem.writeFile("/doc", "stale", { ifMutationToken: held.mutationToken }),
      ),
    ).toMatchObject({
      code: "EREVISION",
    });
    expect(await readText(fileSystem, "/doc")).toBe("source");
  }),
  conformanceCase("conforms: refuses a guard held across a replacing move", async (factory) => {
    const fileSystem = await factory();
    for (const body of ["b1", "b2", "b3"]) await fileSystem.writeFile("/b", body);
    const held = await fileSystem.stat("/b");
    for (const body of ["b4", "b5", "b6"]) await fileSystem.writeFile("/b", body);
    await fileSystem.writeFile("/a", "a1");
    await fileSystem.writeFile("/a", "a2");
    await fileSystem.move("/a", "/b", { replace: true });

    expect(
      await refusal(() =>
        fileSystem.writeFile("/b", "stale", { ifMutationToken: held.mutationToken }),
      ),
    ).toMatchObject({
      code: "EREVISION",
    });
    expect(await readText(fileSystem, "/b")).toBe("a2");
  }),
  conformanceCase(
    "conforms: refuses a guard held across a removal and recreation",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/doc", "original");
      const held = await fileSystem.stat("/doc");
      await fileSystem.remove("/doc");
      await fileSystem.writeFile("/doc", "someone else");

      // Absent-path ABA: a fresh entry starts over, so nothing on the row
      // distinguishes it from the one the guard was taken against.
      expect(
        await refusal(() =>
          fileSystem.writeFile("/doc", "stale", { ifMutationToken: held.mutationToken }),
        ),
      ).toMatchObject({
        code: "EREVISION",
      });
      expect(await readText(fileSystem, "/doc")).toBe("someone else");
    },
  ),
  conformanceCase(
    "conforms: refuses a guard held across a path repointed at another file",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/target", "target untouched");
      await fileSystem.writeFile("/p", "p1");
      await fileSystem.writeFile("/p", "p2");
      const held = await fileSystem.stat("/p");
      for (const body of ["p3", "p4", "p5", "p6"]) await fileSystem.writeFile("/p", body);
      await fileSystem.symlink("/p", "/target", { replace: true });

      // A write resolves before it is guarded, so an unsound guard would be
      // checked against /target and would land on a file the caller never
      // named. The token covers every link crossed, so it refuses instead.
      expect(
        await refusal(() =>
          fileSystem.writeFile("/p", "stale", { ifMutationToken: held.mutationToken }),
        ),
      ).toMatchObject({
        code: "EREVISION",
      });
      expect(await readText(fileSystem, "/target")).toBe("target untouched");
    },
  ),
  conformanceCase("conforms: copies a small file over a larger one", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/small", "abc");
    await fileSystem.writeFile("/large", "x".repeat(100));

    // The destination's bytes are accounted for once, by the removal. Counting
    // them a second time drove the stored total below zero, and the CHECK
    // constraint on it turned an ordinary copy into a failure.
    await fileSystem.copy("/small", "/large", { replace: true });

    expect(await readText(fileSystem, "/large")).toBe("abc");
    expect((await fileSystem.stat("/large")).sizeBytes).toBe(3);
  }),
  conformanceCase(
    "conforms: publishes nothing when skipIfUnchanged matches the stored body",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/snapshot", "body");
      const before = await fileSystem.stat("/snapshot");

      const skipped = await fileSystem.writeFile("/snapshot", "body", { skipIfUnchanged: true });

      // The token it reports is the one still in force, so a caller keeps a
      // guard it can use rather than having to re-read for one.
      expect(skipped).toMatchObject({
        path: "/snapshot",
        revision: before.revision,
        mutationToken: before.mutationToken,
        sizeBytes: 4,
        created: false,
      });
      expect(await fileSystem.stat("/snapshot")).toEqual(before);
      expect(await readText(fileSystem, "/snapshot")).toBe("body");
    },
  ),
  conformanceCase("conforms: decides a body that changed after an append", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/doc", "aa", { skipIfUnchanged: true });
    await fileSystem.writeFile("/doc", "aa", { skipIfUnchanged: true });

    // The append writes chunks and bumps the revision without touching any
    // record of the old body, so a cache trusted blindly would still describe
    // "aa" while the file holds "aabb".
    await fileSystem.appendFile("/doc", "bb");
    const appended = await fileSystem.stat("/doc");

    const same = await fileSystem.writeFile("/doc", "aabb", { skipIfUnchanged: true });
    expect(same.revision).toBe(appended.revision);
    const differing = await fileSystem.writeFile("/doc", "aaXX", { skipIfUnchanged: true });
    expect(differing.revision).toBeGreaterThan(appended.revision);
    expect(await readText(fileSystem, "/doc")).toBe("aaXX");
  }),
  conformanceCase("conforms: decides a body restored to what it was before", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/doc", "aaaa", { skipIfUnchanged: true });
    const first = await fileSystem.stat("/doc");
    await fileSystem.writeFile("/doc", "bbbb", { skipIfUnchanged: true });
    const changed = await fileSystem.stat("/doc");
    expect(changed.revision).toBeGreaterThan(first.revision);

    // Same length both ways, so only the bodies decide it.
    const restored = await fileSystem.writeFile("/doc", "aaaa", { skipIfUnchanged: true });
    expect(restored.revision).toBeGreaterThan(changed.revision);
    const again = await fileSystem.writeFile("/doc", "aaaa", { skipIfUnchanged: true });
    expect(again.revision).toBe(restored.revision);
    expect(await readText(fileSystem, "/doc")).toBe("aaaa");
  }),
  conformanceCase("conforms: decides a body a copy replaced", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/other", "zzzz");
    await fileSystem.writeFile("/doc", "aaaa", { skipIfUnchanged: true });
    await fileSystem.writeFile("/doc", "aaaa", { skipIfUnchanged: true });

    await fileSystem.copy("/other", "/doc", { replace: true });
    const replaced = await fileSystem.stat("/doc");

    // Same length again, and the entry kept its identity, so nothing but the
    // stored body distinguishes this from the state the cache described.
    const stale = await fileSystem.writeFile("/doc", "aaaa", { skipIfUnchanged: true });
    expect(stale.revision).toBeGreaterThan(replaced.revision);
    expect(await readText(fileSystem, "/doc")).toBe("aaaa");
  }),
  conformanceCase("conforms: publishes a differing body under skipIfUnchanged", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/snapshot", "body");
    const before = await fileSystem.stat("/snapshot");

    // Same length, so the size column cannot decide it and the bodies are
    // actually compared.
    const sameLength = await fileSystem.writeFile("/snapshot", "BODY", {
      skipIfUnchanged: true,
    });
    expect(sameLength.revision).toBeGreaterThan(before.revision);
    expect(sameLength.mutationToken).not.toBe(before.mutationToken);
    expect(await readText(fileSystem, "/snapshot")).toBe("BODY");

    const different = await fileSystem.writeFile("/snapshot", "longer body", {
      skipIfUnchanged: true,
    });
    expect(different.revision).toBeGreaterThan(sameLength.revision);
    expect(await readText(fileSystem, "/snapshot")).toBe("longer body");
  }),
  conformanceCase("conforms: creates an absent path under skipIfUnchanged", async (factory) => {
    const fileSystem = await factory();
    const created = await fileSystem.writeFile("/fresh", "body", { skipIfUnchanged: true });
    expect(created.created).toBe(true);
    expect(await readText(fileSystem, "/fresh")).toBe("body");
  }),
  conformanceCase(
    "conforms: still refuses a stale guard when skipIfUnchanged would match",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/guarded-skip", "body");
      const stale = await fileSystem.getMutationToken("/guarded-skip");
      await fileSystem.writeFile("/guarded-skip", "other");
      await fileSystem.writeFile("/guarded-skip", "body");

      // The bytes match again, but the guard is from before the round trip. An
      // unchanged body must not turn a refusal into a success.
      const refused = await Promise.resolve()
        .then(() =>
          fileSystem.writeFile("/guarded-skip", "body", {
            skipIfUnchanged: true,
            ifMutationToken: stale,
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).toMatchObject({ code: "EREVISION", path: "/guarded-skip" });
    },
  ),
  conformanceCase(
    "conforms: keeps disposition and directory refusals under skipIfUnchanged",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/taken", "body");
      const taken = await Promise.resolve()
        .then(() =>
          fileSystem.writeFile("/taken", "body", {
            skipIfUnchanged: true,
            disposition: "create",
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(taken).toMatchObject({ code: "EEXIST" });

      await fileSystem.mkdir("/directory");
      const directory = await Promise.resolve()
        .then(() => fileSystem.writeFile("/directory", "body", { skipIfUnchanged: true }))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(directory).toMatchObject({ code: "EISDIR" });
    },
  ),
  conformanceCase("conforms: writes when only the requested mode differs", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/moded", "body", { mode: 0o644 });
    const before = await fileSystem.stat("/moded");

    const unchanged = await fileSystem.writeFile("/moded", "body", {
      skipIfUnchanged: true,
      mode: 0o644,
    });
    expect(unchanged.revision).toBe(before.revision);

    // The mode is part of what the call asked for, so a body that matches is
    // not on its own a reason to decline it.
    const remoded = await fileSystem.writeFile("/moded", "body", {
      skipIfUnchanged: true,
      mode: 0o600,
    });
    expect(remoded.revision).toBeGreaterThan(before.revision);
    expect((await fileSystem.stat("/moded")).mode & 0o777).toBe(0o600);
  }),
  optionalConformanceCase(
    "negativeMutationRaces",
    "conforms: rejects copying a path onto itself without changing its contents",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/same", "body");
      const before = await fileSystem.stat("/same");

      const copyError = await Promise.resolve()
        .then(() => fileSystem.copy("/same", "/same", { replace: true }))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(copyError).toMatchObject({ code: "EINVAL", path: "/same" });

      expect(await fileSystem.stat("/same")).toEqual(before);
      expect(
        new TextDecoder().decode(
          await readAllBytes((await fileSystem.readFile("/same")).stream, 16),
        ),
      ).toBe("body");
    },
  ),
  optionalConformanceCase(
    "negativeMutationRaces",
    "conforms: rechecks the path token after collecting an empty append",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/append-race", "old");
      let finish: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          finish = () => controller.close();
        },
      });

      const appending = fileSystem.appendFile("/append-race", body);
      const observed = appending.then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.resolve();
      await fileSystem.touch("/append-race");
      finish?.();

      expect(await observed).toMatchObject({ code: "EREVISION", path: "/append-race" });
    },
  ),
  conformanceCase(
    "conforms: publishes subtree tokens for copy, move, and remove",
    async (factory) => {
      const fileSystem = await factory();
      await fileSystem.mkdir("/source");
      await fileSystem.writeFile("/source/file", "body");
      const sourceToken = await fileSystem.getMutationToken("/source/file");
      const absentCopyToken = await fileSystem.getMutationToken("/copy/file");

      await fileSystem.copy("/source", "/copy", { recursive: true });
      const copiedToken = await fileSystem.getMutationToken("/copy/file");
      expect(copiedToken).not.toBe(absentCopyToken);
      expect(await fileSystem.getMutationToken("/source/file")).toBe(sourceToken);

      const absentMovedToken = await fileSystem.getMutationToken("/moved/file");
      await fileSystem.move("/copy", "/moved");
      const movedToken = await fileSystem.getMutationToken("/moved/file");
      expect(movedToken).not.toBe(absentMovedToken);
      expect(await fileSystem.getMutationToken("/copy/file")).not.toBe(copiedToken);

      await fileSystem.remove("/moved", { recursive: true });
      expect(await fileSystem.getMutationToken("/moved/file")).not.toBe(movedToken);
    },
  ),
  conformanceCase("conforms: summarizes a subtree without a result ceiling", async (factory) => {
    const fileSystem = await factory();
    await fileSystem.mkdir("/counted/nested", true);
    await fileSystem.writeFile("/counted/file", "body");
    await fileSystem.writeFile("/counted/nested/leaf", "body");

    // /counted, /counted/file, /counted/nested, /counted/nested/leaf
    expect(await fileSystem.subtreeSummary("/counted")).toEqual({
      entries: 4,
      inlineBytes: 8,
      logicalFileBytes: 8,
    });
    expect(await fileSystem.subtreeSummary("/counted/nested")).toEqual({
      entries: 2,
      inlineBytes: 4,
      logicalFileBytes: 4,
    });
    expect(await fileSystem.subtreeSummary("/counted/file")).toEqual({
      entries: 1,
      inlineBytes: 4,
      logicalFileBytes: 4,
    });
    expect((await fileSystem.subtreeSummary("/")).entries).toBe(
      (await fileSystem.find({ path: "/", includeRoot: true })).length,
    );

    // A local backend throws synchronously; RPC rejects. Normalize both.
    await expect(
      (async () => fileSystem.subtreeSummary("/counted/absent"))(),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }),
];
