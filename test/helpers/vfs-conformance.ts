import { describe, expect, it } from "vitest";
import { readAllBytes } from "../../src/vfs/streams.js";
import type { VirtualFileSystem } from "../../src/vfs/types.js";

// Durable Object RPC turns synchronous server results into promises at the caller boundary.
type RpcCompatibleVirtualFileSystem = {
  [Method in keyof VirtualFileSystem]: VirtualFileSystem[Method] extends (
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result | Promise<Awaited<Result>>
    : never;
};

export type VfsFactory = () =>
  | RpcCompatibleVirtualFileSystem
  | Promise<RpcCompatibleVirtualFileSystem>;

async function readText(fileSystem: RpcCompatibleVirtualFileSystem, path: string): Promise<string> {
  return new TextDecoder().decode(
    await readAllBytes((await fileSystem.readFile(path)).stream, 1024),
  );
}

function gatedBody(value: string): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly pulled: Promise<void>;
  close(): void;
} {
  let release: (() => void) | undefined;
  let markPulled: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pulled = new Promise<void>((resolve) => {
    markPulled = resolve;
  });
  let sent = false;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(value));
          markPulled?.();
          return;
        }
        return closed.then(() => controller.close());
      },
    }),
    pulled,
    close() {
      release?.();
    },
  };
}

export function streamThatFailsAfter(value: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(value));
        return;
      }
      controller.error(new Error("source failed"));
    },
  });
}

/**
 * The error a call refused with, or null if it did not refuse.
 *
 * The rejection handler is attached where the promise is created rather than
 * through `expect().rejects`, which the Durable Object backend needs: the RPC
 * stub reports an unconsumed rejection as an unhandled error even when the
 * assertion itself passes.
 */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

export function runVfsConformance(
  factory: VfsFactory,
  options: {
    negativeMutationRaces?: boolean;
    failedInputStreams?: boolean;
  } = {},
): void {
  it("conforms: preserves arbitrary bytes through streamed snapshots", async () => {
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
  });

  it("conforms: keeps a streamed create absent until the complete body is published", async () => {
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
  });

  it("conforms: keeps the previous generation visible until a streamed replacement closes", async () => {
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
  });

  if (options.failedInputStreams !== false)
    it("conforms: publishes no partial generation when an input stream fails", async () => {
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
    });

  it("conforms: accepts the current mutation token and publishes a new one", async () => {
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
  });

  it("conforms: keeps an entry's identity through a move and a rewrite", async () => {
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
  });

  it("conforms: never hands an identity out again", async () => {
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
  });

  it("conforms: makes the three ways of replacing content agree on identity", async () => {
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
  });

  it("conforms: preserves nothing when the destination is not a file", async () => {
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
  });

  it("conforms: gives every copied entry an identity of its own", async () => {
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
  });

  describe("reading by entry identity", () => {
    it("conforms: finds an entry that moved out from under a held identity", async () => {
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
    });

    it("conforms: reports the entry itself rather than what it points at", async () => {
      const fileSystem = await factory();
      await fileSystem.writeFile("/target", "body");
      await fileSystem.symlink("/link", "/target");
      const link = await fileSystem.lstat("/link");

      // An identity names a row, so there is nothing to resolve through.
      const found = await fileSystem.statById(link.ino);
      expect(found).toMatchObject({ path: "/link", kind: "symlink", linkTarget: "/target" });
      expect(found.ino).not.toBe((await fileSystem.stat("/target")).ino);
    });

    it("conforms: refuses an identity no entry holds", async () => {
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
    });

    it("conforms: refuses an identity that was never issuable", async () => {
      const fileSystem = await factory();
      // Zero is the documented sentinel for a path answered above the
      // namespace, so it must not read as "an entry that is gone".
      for (const candidate of [0, -1, 1.5]) {
        expect(await refusal(async () => fileSystem.statById(candidate))).toMatchObject({
          code: "EINVAL",
        });
      }
    });
  });

  describe("revision monotonicity", () => {
    // A path's revision never goes backwards. Every site where an entry lands
    // on an occupied path takes one past whatever was there, so a caller that
    // displays or logs a version never sees it jump back.
    it("conforms: advances the revision when a copy replaces a file", async () => {
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
    });

    it("conforms: advances the revision when a move replaces a file", async () => {
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
    });

    it("conforms: advances the revision when a link replaces a file", async () => {
      const fileSystem = await factory();
      for (const body of ["v1", "v2", "v3", "v4"]) await fileSystem.writeFile("/link", body);
      const before = await fileSystem.lstat("/link");
      await fileSystem.writeFile("/target", "t");

      const created = await fileSystem.symlink("/link", "/target", { replace: true });

      expect(created.revision).toBe(before.revision + 1);
      expect((await fileSystem.lstat("/link")).revision).toBe(before.revision + 1);
    });

    it("conforms: starts at one wherever nothing was there", async () => {
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
    });

    it("conforms: keeps (ino, revision) moving forward across a replacement", async () => {
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
    });
  });

  // The four ways a path can carry a stale guard. `revision` matches again in
  // every one of them, which is why it is an observable rather than a
  // precondition; the token composes each crossed path's version and retains
  // it as a tombstone, so it refuses all four.
  describe("mutation-token guards", () => {
    it("conforms: refuses a guard held across a replacing copy", async () => {
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
    });

    it("conforms: refuses a guard held across a replacing move", async () => {
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
    });

    it("conforms: refuses a guard held across a removal and recreation", async () => {
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
    });

    it("conforms: refuses a guard held across a path repointed at another file", async () => {
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
    });
  });

  it("conforms: copies a small file over a larger one", async () => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/small", "abc");
    await fileSystem.writeFile("/large", "x".repeat(100));

    // The destination's bytes are accounted for once, by the removal. Counting
    // them a second time drove the stored total below zero, and the CHECK
    // constraint on it turned an ordinary copy into a failure.
    await fileSystem.copy("/small", "/large", { replace: true });

    expect(await readText(fileSystem, "/large")).toBe("abc");
    expect((await fileSystem.stat("/large")).sizeBytes).toBe(3);
  });

  it("conforms: publishes nothing when skipIfUnchanged matches the stored body", async () => {
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
  });

  // A recorded digest is a cache, so what matters is that it can never make
  // skipIfUnchanged answer wrongly -- including where a write path changes the
  // body without clearing it, which the revision stamp is what prevents.
  it("conforms: decides a body that changed after an append", async () => {
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
  });

  it("conforms: decides a body restored to what it was before", async () => {
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
  });

  it("conforms: decides a body a copy replaced", async () => {
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
  });

  it("conforms: publishes a differing body under skipIfUnchanged", async () => {
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
  });

  it("conforms: creates an absent path under skipIfUnchanged", async () => {
    const fileSystem = await factory();
    const created = await fileSystem.writeFile("/fresh", "body", { skipIfUnchanged: true });
    expect(created.created).toBe(true);
    expect(await readText(fileSystem, "/fresh")).toBe("body");
  });

  it("conforms: still refuses a stale guard when skipIfUnchanged would match", async () => {
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
  });

  it("conforms: keeps disposition and directory refusals under skipIfUnchanged", async () => {
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
  });

  it("conforms: writes when only the requested mode differs", async () => {
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
  });

  if (options.negativeMutationRaces !== false)
    it("conforms: rejects copying a path onto itself without changing its contents", async () => {
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
    });

  if (options.negativeMutationRaces !== false)
    it("conforms: rechecks the path token after collecting an empty append", async () => {
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
    });

  it("conforms: publishes subtree tokens for copy, move, and remove", async () => {
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
  });

  it("conforms: counts a subtree without a result ceiling", async () => {
    const fileSystem = await factory();
    await fileSystem.mkdir("/counted/nested", true);
    await fileSystem.writeFile("/counted/file", "body");
    await fileSystem.writeFile("/counted/nested/leaf", "body");

    // /counted, /counted/file, /counted/nested, /counted/nested/leaf
    expect(await fileSystem.countSubtree("/counted")).toBe(4);
    expect(await fileSystem.countSubtree("/counted/nested")).toBe(2);
    expect(await fileSystem.countSubtree("/counted/file")).toBe(1);
    expect(await fileSystem.countSubtree("/")).toBe(
      (await fileSystem.find({ path: "/", includeRoot: true })).length,
    );

    // A local backend throws synchronously; RPC rejects. Normalize both.
    await expect((async () => fileSystem.countSubtree("/counted/absent"))()).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  describe("batched writes", () => {
    it("conforms: publishes a set of bodies as one change", async () => {
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
    });

    it("conforms: leaves every path as it was when a later entry refuses", async () => {
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
    });

    it("conforms: creates nothing when an entry in the set is a directory", async () => {
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
    });

    it("conforms: refuses a batch that names one path more than once", async () => {
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
    });

    it("conforms: reports the revision already in force for a matched skip", async () => {
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
    });

    it("conforms: guards every entry against the token it was read at", async () => {
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
    });

    it("conforms: writes nothing for an empty set", async () => {
      const fileSystem = await factory();
      expect(await fileSystem.writeFiles([])).toEqual([]);
    });
  });

  it("conforms: applies namespace operations and paginated traversal consistently", async () => {
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

    expect(await fileSystem.remove("/tree", { recursive: true })).toMatchObject({ removed: 3 });
    expect((await fileSystem.list("/")).map((entry) => entry.path)).not.toContain("/tree");
  });
}
