import { describe, expect, it } from "vitest";
import { readAllBytes } from "../src/vfs/streams.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...(await readAllBytes(stream, 16 * 1024 * 1024))];
}

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
      expect(() => view.statById(ino)).toThrow(expect.objectContaining({ code: "EPERM" }) as Error);
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
it("summarizes a subtree past the ceiling that truncates find()", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.mkdir("/bulk");
  for (let index = 0; index < 10_050; index += 1) {
    await fileSystem.writeFile(`/bulk/f${index}`, "x");
  }

  // find() materializes a VfsStat per entry and stops at its 10,000 default,
  // so it cannot be used to charge a mutation budget accurately.
  expect(fileSystem.find({ path: "/bulk", includeRoot: true })).toHaveLength(10_000);
  expect(fileSystem.subtreeSummary("/bulk")).toEqual({
    entries: 10_051,
    inlineBytes: 10_050,
    logicalFileBytes: 10_050,
  });
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

it("keeps stored bytes independent from chunks transferred to a reader", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/data", Uint8Array.of(1, 2, 3));

  const reader = fileSystem.readFile("/data").stream.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  first.value?.fill(9);
  await reader.cancel();

  expect(await bytes(fileSystem.readFile("/data").stream)).toEqual([1, 2, 3]);
});

it("linearizes a materialized write before returning its promise", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/file", "old");

  const writing = fileSystem.writeFile("/file", "new");
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/file").stream, 16)),
  ).toBe("new");
  await writing;
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

it("revalidates a guarded typed view after its accessors mutate the path", async () => {
  const fileSystem = createTestFileSystem();
  const created = await fileSystem.writeFile("/file", "old");
  let mutated = false;
  class MutatingBytes extends Uint8Array {
    override get buffer(): ArrayBuffer {
      if (!mutated) {
        mutated = true;
        fileSystem.touch("/file");
      }
      return super.buffer as ArrayBuffer;
    }
  }

  await expect(
    fileSystem.writeFile("/file", new MutatingBytes([110, 101, 119]), {
      ifMutationToken: created.mutationToken,
    }),
  ).rejects.toMatchObject({ code: "EREVISION", path: "/file" });
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/file").stream, 16)),
  ).toBe("old");
});

it("revalidates a guarded batch after a body getter mutates the path", async () => {
  const fileSystem = createTestFileSystem();
  const created = await fileSystem.writeFile("/file", "old");
  let mutated = false;
  const entry = {
    path: "/file",
    ifMutationToken: created.mutationToken,
    get body(): string {
      if (!mutated) {
        mutated = true;
        fileSystem.touch("/file");
      }
      return "new";
    },
  };

  await expect(fileSystem.writeFiles([entry])).rejects.toMatchObject({
    code: "EREVISION",
    path: "/file",
  });
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/file").stream, 16)),
  ).toBe("old");
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
