import { describe, expect, it } from "vitest";
import type { VfsEvent } from "../src/vfs/events.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

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

it("still reads both dynamic limits for a same-size replacement", async () => {
  let inlineCalls = 0;
  let entryCalls = 0;
  let inlineLimit = 100;
  const fileSystem = createTestFileSystem({
    maxInlineLogicalBytes: () => {
      inlineCalls += 1;
      return inlineLimit;
    },
    maxEntries: () => {
      entryCalls += 1;
      return 100;
    },
  });
  await fileSystem.writeFile("/a", "old!");
  const before = { inlineCalls, entryCalls };

  await fileSystem.writeFile("/a", "new!");
  expect(inlineCalls).toBe(before.inlineCalls + 1);
  expect(entryCalls).toBe(before.entryCalls + 1);

  inlineLimit = 0;
  await expect(fileSystem.writeFile("/a", "old!")).rejects.toMatchObject({
    code: "EINVAL",
  });
  expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/a").stream, 16))).toBe(
    "new!",
  );
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
