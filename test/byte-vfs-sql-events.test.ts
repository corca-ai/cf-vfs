import { expect, it } from "vitest";
import type { VfsEvent } from "../src/vfs/events.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

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

it("does not lose paths when a page limit cuts through a set-based change", async () => {
  const fileSystem = createTestFileSystem({ recordChanges: true });
  await fileSystem.writeFile("/tree/a", "a", { createParents: true });
  await fileSystem.writeFile("/tree/b", "b");
  const seen = fileSystem.changesSince(0).cursor;

  await fileSystem.move("/tree", "/moved");
  const collected: { path: string; present: boolean }[] = [];
  let cursor = seen;
  for (;;) {
    const page = fileSystem.changesSince(cursor, { limit: 1 });
    collected.push(...page.changes);
    cursor = page.cursor;
    if (!page.more) break;
  }

  expect(collected).toEqual([
    { path: "/tree", present: false },
    { path: "/tree/a", present: false },
    { path: "/tree/b", present: false },
    { path: "/moved", present: true },
    { path: "/moved/a", present: true },
    { path: "/moved/b", present: true },
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
  expect(() => off.changesSince(0)).toThrow(expect.objectContaining({ code: "ENOTSUP" }) as Error);

  const on = createTestFileSystem({ recordChanges: true });
  expect(() => on.forCredentials({ uid: 1000, gid: 1000 }).changesSince(0)).toThrow(
    expect.objectContaining({ code: "EPERM" }) as Error,
  );
  expect(() => on.changesSince(-1)).toThrow(expect.objectContaining({ code: "EINVAL" }) as Error);
});
