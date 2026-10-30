import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import type { NodeSqlFileSystem } from "../src/testing/node.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { putOpaque } from "../src/vfs/opaque.js";
import { reads } from "../src/vfs/sql-changes.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

// Read-ahead trusts a body only while changeGeneration holds still, so every
// way of changing the storage must move it. A missed write would hand out a
// stale body; an extra move only costs a reread.

type Mutation = (fs: NodeSqlFileSystem, view: VirtualFileSystem) => unknown;

const MUTATIONS: Record<string, Mutation> = {
  writeFile: (fs) => fs.writeFile("/d/a", "new"),
  writeFiles: (fs) => fs.writeFiles([{ path: "/d/new", body: "x" }]),
  appendFile: (fs) => fs.appendFile("/d/a", "more"),
  touch: (fs) => fs.touch("/d/a", { modifiedAtMs: 1 }),
  setMetadata: (fs) => fs.setMetadata("/d/a", { mode: 0o600 }),
  setOwnership: (fs) => fs.setOwnership("/d/a", { uid: 7 }),
  mkdir: (fs) => fs.mkdir("/d/sub"),
  remove: (fs) => fs.remove("/d/a"),
  removeTree: (fs) => fs.remove("/d", { recursive: true }),
  move: (fs) => fs.move("/d/a", "/d/moved"),
  copy: (fs) => fs.copy("/d", "/copied", { recursive: true }),
  // The credential-bound copy is the one statement that starts with WITH.
  copyWithCredentials: (_fs, view) => view.copy("/d", "/copied", { recursive: true }),
  writeWithCredentials: (_fs, view) => view.writeFile("/d/a", "theirs"),
  symlink: (fs) => fs.symlink("/link", "/d/a"),
  linkFile: (fs) => createFsAdapter(fs).promises.link("/d/a", "/d/hard"),
  handleWrite: async (fs) => {
    const handle = await createFsAdapter(fs).promises.open("/d/a", "r+");
    await handle.write("zz", 0);
    await handle.close();
  },
  handleTruncate: async (fs) => {
    const handle = await createFsAdapter(fs).promises.open("/d/a", "r+");
    await handle.truncate(1);
    await handle.close();
  },
  opaque: (fs) => putOpaque(fs, opaqueStore, "/d/blob", "body", { contentType: "text/plain" }),
};

const opaqueStore = new MemoryOpaqueStore();

it.each(Object.entries(MUTATIONS))("%s moves the change generation", async (_name, mutate) => {
  const fs = createTestFileSystem({ opaqueStore });
  fs.setMetadata("/", { mode: 0o777 });
  fs.mkdir("/d", false, 0o777);
  await fs.writeFile("/d/a", "body", { mode: 0o666 });
  await fs.writeFile("/d/b", "other", { mode: 0o666 });
  const view = fs.forCredentials({ uid: 1000, gid: 1000 });
  const before = fs.changeGeneration();
  expect(view.changeGeneration?.()).toBe(before);
  await mutate(fs, view);
  expect(fs.changeGeneration()).not.toBe(before);
  expect(view.changeGeneration?.()).toBe(fs.changeGeneration());
});

it("is shared by every filesystem over the same storage", async () => {
  const fs = createTestFileSystem();
  await fs.writeFile("/a", "body");
  const other = fs.forCredentials({ uid: 0, gid: 0 });
  const before = other.changeGeneration?.();
  await fs.writeFile("/a", "changed");
  expect(other.changeGeneration?.()).not.toBe(before);
});

// Opcodes that change the database file, as opposed to an ephemeral table a
// read builds for itself. A statement the counter treats as a read must
// compile to none of them, or a write would leave the generation still.
const WRITE_OPCODES = new Set(["OpenWrite", "Clear", "Destroy", "CreateBtree", "VUpdate"]);

it("treats as reads only statements SQLite compiles without a write", async () => {
  const queries = new Set<string>();
  const run = async (name: string, mutate: Mutation) => {
    const fs = createTestFileSystem({ opaqueStore, onStatement: (query) => queries.add(query) });
    fs.setMetadata("/", { mode: 0o777 });
    fs.mkdir("/d", false, 0o777);
    await fs.writeFile("/d/a", "body", { mode: 0o666 });
    await fs.writeFile("/d/b", "other", { mode: 0o666 });
    const view = fs.forCredentials({ uid: 1000, gid: 1000 });
    await mutate(fs, view);
    view.statMany?.(["/d/a", "/d/b"]);
    view.readMany?.(["/d/a", "/d/b"]);
    const database = Reflect.get(Reflect.get(fs, "nodeStorage"), "database") as DatabaseSync;
    const writers = [...queries].filter((query) => {
      if (!reads(query)) return false;
      const plan = database.prepare(`EXPLAIN ${query}`).all();
      return plan.some((row) => WRITE_OPCODES.has(String(row["opcode"])));
    });
    expect(writers, name).toEqual([]);
    queries.clear();
  };
  for (const [name, mutate] of Object.entries(MUTATIONS)) await run(name, mutate);
});
