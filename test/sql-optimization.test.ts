import { afterEach, expect, it } from "vitest";
import { NodeSqlFileSystem } from "../src/testing/node.js";
import type { VfsEvent } from "../src/vfs/events.js";
import { readUtf8 } from "../src/vfs/streams.js";
import type { FindOptions } from "../src/vfs/types.js";

const opened: NodeSqlFileSystem[] = [];
afterEach(() => {
  for (const fs of opened.splice(0)) fs.close();
});
function open(options: ConstructorParameters<typeof NodeSqlFileSystem>[0] = {}) {
  const fs = new NodeSqlFileSystem(options);
  opened.push(fs);
  return fs;
}

it("includes newly created parents in the final batch entry quota", async () => {
  const fs = open({ maxEntries: 4 });
  await expect(
    fs.writeFiles(
      [
        { path: "/a/b/x", body: "x" },
        { path: "/a/b/y", body: "y" },
      ],
      { createParents: true },
    ),
  ).rejects.toMatchObject({ code: "ENOSPC" });
  expect(fs.list("/")).toEqual([]);
  await fs.writeFiles([{ path: "/a/b/x", body: "x" }], { createParents: true });
  expect(fs.find({ path: "/", includeRoot: true })).toHaveLength(4);
});

it("flushes batch usage once, including created parents, and discards failed totals", async () => {
  const events: VfsEvent[] = [];
  let updates = 0;
  const fs = open({
    maxInlineLogicalBytes: 6,
    onEvent: (event) => events.push(event),
    onStatement: (query) => {
      if (query.startsWith("UPDATE vfs_usage")) updates += 1;
    },
  });
  updates = 0;
  await fs.writeFiles(
    [
      { path: "/a/b/x", body: "xx" },
      { path: "/a/b/y", body: "yyyy" },
    ],
    { createParents: true },
  );
  expect(updates).toBe(1);
  expect(events.filter((event) => event.type === "vfs.usage")).toEqual([
    { type: "vfs.usage", inlineBytes: 6, entries: 5 },
  ]);
  events.length = 0;
  await expect(
    fs.writeFiles([
      { path: "/a/b/x", body: "xxxxx" },
      { path: "/new", body: "z" },
    ]),
  ).rejects.toMatchObject({ code: "ENOSPC" });
  expect(events.some((event) => event.type === "vfs.usage")).toBe(false);
  expect(fs.stat("/a/b/x").sizeBytes).toBe(2);
  expect(() => fs.stat("/new")).toThrow();
  await fs.writeFiles([
    { path: "/a/b/x", body: "xxxx" },
    { path: "/a/b/y", body: "yy" },
  ]);
  expect(events.filter((event) => event.type === "vfs.usage")).toEqual([
    { type: "vfs.usage", inlineBytes: 6, entries: 5 },
  ]);
  await fs.writeFile("/a/b/x", "x");
  expect(events.at(-2)).toMatchObject({ type: "vfs.usage", inlineBytes: 3, entries: 5 });
});

it("rejects a string append if a synchronous host callback changes its version", async () => {
  let armed = false;
  const fs = open({
    now: () => {
      if (armed) {
        armed = false;
        fs.touch("/body");
      }
      return 1;
    },
  });
  await fs.writeFile("/body", "original");
  const token = fs.getMutationToken("/body");
  armed = true;
  await expect(fs.appendFile("/body", "suffix")).rejects.toMatchObject({ code: "EREVISION" });
  expect(await readUtf8(fs.readFile("/body").stream, 100)).toBe("original");
  expect(fs.getMutationToken("/body")).toBe(token);
  await fs.appendFile("/body", "suffix");
  expect(await readUtf8(fs.readFile("/body").stream, 100)).toBe("originalsuffix");
});

function pagedPaths(fs: NodeSqlFileSystem, options: FindOptions): string[] {
  const paths: string[] = [];
  let cursor = options.cursor;
  do {
    const page = fs.findPage({ ...options, ...(cursor === undefined ? {} : { cursor }), limit: 3 });
    paths.push(...page.entries.map((entry) => entry.path));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return paths.slice(0, options.limit ?? 10000);
}

it.each([
  ["a".repeat(49), true],
  ["a".repeat(50), false],
  [`${"한".repeat(16)}a`, true],
  [`${"한".repeat(16)}ab`, false],
  [`${"😀".repeat(12)}a`, true],
  [`${"😀".repeat(12)}ab`, false],
] as const)("keeps the SQL name prefilter within 50 UTF-8 bytes for %j", async (name, usesGlob) => {
  const statements: string[] = [];
  const fs = open({ onStatement: (query) => statements.push(query) });
  await fs.writeFile(`/tree/${name}`, "x", { createParents: true });
  await fs.writeFile(`/tree/${name}suffix`, "x");
  await fs.writeFile("/tree/other", "x");
  for (const pattern of [name, `${name}*`]) {
    statements.length = 0;
    const paths = fs.find({ path: "/tree", name: pattern }).map((entry) => entry.path);
    expect(statements.some((query) => query.includes(" GLOB "))).toBe(usesGlob);
    expect(paths).toEqual(
      pattern === name ? [`/tree/${name}`] : [`/tree/${name}`, `/tree/${name}suffix`],
    );
  }
});

it.each(["*", "target", "target*", "*.txt", "?", "[ta]*", "t\\*", "😀*", "", "*\n"])(
  "preserves find results and paged traversal for %j",
  async (name) => {
    const fs = open();
    for (const file of [
      "target",
      "target\n",
      "target\r\n",
      "target.txt",
      "target.txt.bak",
      "other",
      "😀",
      "\ue000",
      "t*",
      "nested/target",
      "nested/deep/target",
    ])
      await fs.writeFile(`/tree/${file}`, "x", { createParents: true });
    for (const maxDepth of [0, 1, 2, 0.5, 1.5, Number.POSITIVE_INFINITY]) {
      for (const cursor of ["", "/tree/target", "/tree/😀"]) {
        const options = { path: "/tree", name, maxDepth, cursor, includeRoot: true, limit: 5 };
        expect(fs.find(options).map((entry) => entry.path)).toEqual(pagedPaths(fs, options));
      }
    }
  },
);
