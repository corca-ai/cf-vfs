import { expect, it } from "vitest";
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
