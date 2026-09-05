import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { NodeSqlFileSystem } from "../src/testing/node.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { createTestFileSystem } from "./helpers/node-sql.js";
import { meteredFileSystem } from "./helpers/performance.js";

it("batches inline chunk writes at the bound-parameter ceiling", async () => {
  async function statements(chunks: number, append: boolean): Promise<number> {
    const { fileSystem, meter } = meteredFileSystem({ chunkBytes: 4 });
    if (append) await fileSystem.writeFile("/body", new Uint8Array(4));
    meter.reset();
    if (append) await fileSystem.appendFile("/body", new Uint8Array(chunks * 4));
    else await fileSystem.writeFile("/body", new Uint8Array(chunks * 4));
    return meter.statements;
  }

  const writes = {
    one: await statements(1, false),
    thirtyThree: await statements(33, false),
    thirtyFour: await statements(34, false),
  };
  const appends = {
    one: await statements(1, true),
    thirtyThree: await statements(33, true),
    thirtyFour: await statements(34, true),
  };
  expect(writes.thirtyThree).toBe(writes.one);
  expect(writes.thirtyFour).toBe(writes.one + 1);
  expect(appends.thirtyThree).toBe(appends.one);
  expect(appends.thirtyFour).toBe(appends.one + 1);
});

it("overwrites retained chunks in place and deletes only a shrinking suffix", async () => {
  async function overwrite(sizeBytes: number): Promise<{
    statements: number;
    chunkDeletes: number;
    body: number[];
  }> {
    let statements = 0;
    let chunkDeletes = 0;
    const fileSystem = createTestFileSystem({
      chunkBytes: 4,
      onStatement: (query) => {
        statements += 1;
        if (/DELETE FROM vfs_inline_chunks/u.test(query)) chunkDeletes += 1;
      },
    });
    await fileSystem.writeFile("/body", new Uint8Array(12).fill(1));
    statements = 0;
    chunkDeletes = 0;
    await fileSystem.writeFile("/body", new Uint8Array(sizeBytes).fill(2));
    const measured = { statements, chunkDeletes };
    const body = await readAllBytes(fileSystem.readFile("/body").stream, 16);
    return { ...measured, body: [...body] };
  }

  const sameSize = await overwrite(12);
  const growing = await overwrite(16);
  const shrinking = await overwrite(4);
  expect(sameSize).toEqual({ statements: 6, chunkDeletes: 0, body: Array(12).fill(2) });
  expect(growing).toEqual({ statements: 8, chunkDeletes: 0, body: Array(16).fill(2) });
  expect(shrinking).toEqual({ statements: 8, chunkDeletes: 1, body: Array(4).fill(2) });
});

it("materializes only inline chunks intersecting a byte range", async () => {
  const { fileSystem, meter } = meteredFileSystem({ chunkBytes: 4 });
  await fileSystem.writeFile(
    "/body",
    Uint8Array.from({ length: 16 }, (_, index) => index),
  );

  meter.reset();
  const middle = await readAllBytes(
    fileSystem.readFile("/body", { range: { offset: 5, length: 3 } }).stream,
    16,
  );
  expect([...middle]).toEqual([5, 6, 7]);
  expect(meter).toMatchObject({ statements: 3, rows: 3 });

  meter.reset();
  const suffix = await readAllBytes(
    fileSystem.readFile("/body", { range: { suffix: 2 } }).stream,
    16,
  );
  expect([...suffix]).toEqual([14, 15]);
  // The immutable entry revision keys the stored chunk-width cache.
  expect(meter).toMatchObject({ statements: 2, rows: 2 });

  meter.reset();
  await readAllBytes(fileSystem.readFile("/body").stream, 16);
  expect(meter).toMatchObject({ statements: 2, rows: 5 });
});

it("keeps the simpler range path for a small single-chunk file", async () => {
  const queries: string[] = [];
  const fileSystem = createTestFileSystem({
    onStatement: (query) => queries.push(query),
  });
  await fileSystem.writeFile("/body", new Uint8Array(10 * 1024));

  queries.length = 0;
  await readAllBytes(
    fileSystem.readFile("/body", { range: { offset: 0, length: 1024 } }).stream,
    1024,
  );
  const chunkQuery = queries.find((query) => query.includes("vfs_inline_chunks"));
  expect(chunkQuery).toContain("SELECT body");
  expect(chunkQuery).not.toContain("substr(");
});

it("answers inline wc -c from bounded metadata work", async () => {
  const { fileSystem, meter } = meteredFileSystem({ chunkBytes: 4 });
  await fileSystem.writeFile("/body", new Uint8Array(16));
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });

  meter.reset();
  expect(await shell.executeText({ script: "wc -c /body" })).toMatchObject({
    exitCode: 0,
    stdout: "16 /body\n",
  });
  expect(meter).toMatchObject({ statements: 3, rows: 3 });

  meter.reset();
  expect((await shell.executeText({ script: "wc -l /body" })).exitCode).toBe(0);
  expect(meter).toMatchObject({ statements: 2, rows: 5 });
});

it("answers du with a fixed-size subtree aggregate", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  await fileSystem.writeFile("/tree/a", new Uint8Array(1_500), { createParents: true });
  await fileSystem.writeFile("/tree/nested/b", new Uint8Array(700), { createParents: true });
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });

  meter.reset();
  expect(await shell.executeText({ script: "du /tree" })).toMatchObject({
    exitCode: 0,
    stdout: "3\t/tree\n",
  });
  expect(meter).toMatchObject({ statements: 2, rows: 2 });
});

it("keeps batch aggregation cheaper than separate writes", async () => {
  async function counted(
    run: (fileSystem: NodeSqlFileSystem) => Promise<unknown>,
  ): Promise<{ statements: number; rows: number }> {
    const { fileSystem, meter } = meteredFileSystem();
    meter.reset();
    await run(fileSystem);
    return { statements: meter.statements, rows: meter.rows };
  }

  const paths = ["/a", "/b", "/c"];
  const single = await counted((fileSystem) => fileSystem.writeFile("/a", "body"));
  const batchOfOne = await counted((fileSystem) =>
    fileSystem.writeFiles([{ path: "/a", body: "body" }]),
  );
  const batchOfThree = await counted((fileSystem) =>
    fileSystem.writeFiles(paths.map((path) => ({ path, body: "body" }))),
  );
  const threeWrites = await counted(async (fileSystem) => {
    for (const path of paths) await fileSystem.writeFile(path, "body");
  });

  // A string write can prove that collection runs no caller code; a batch
  // must revalidate because an entry getter can. That one-statement safety
  // cost is paid once per batch entry and does not erase aggregation's gain.
  expect(single).toEqual({ statements: 8, rows: 2 });
  expect(batchOfOne).toEqual({ statements: 9, rows: 2 });
  // A set shares the transaction, usage read, and usage UPDATE across entries.
  expect(batchOfThree).toEqual({ statements: 19, rows: 4 });
  expect(threeWrites).toEqual({ statements: 24, rows: 6 });
});

it("skips subtree summaries without slowing a rejected directory removal", async () => {
  async function statements(
    setup: (fileSystem: NodeSqlFileSystem) => unknown | Promise<unknown>,
    recursive = false,
    rejected = false,
  ): Promise<number> {
    const { fileSystem, meter } = meteredFileSystem();
    await setup(fileSystem);
    meter.reset();
    const removing = fileSystem.remove("/target", { recursive });
    if (rejected) await expect(removing).rejects.toMatchObject({ code: "ENOTEMPTY" });
    else await removing;
    return meter.statements;
  }

  expect({
    file: await statements((fileSystem) => fileSystem.writeFile("/target", "x")),
    emptyDirectory: await statements((fileSystem) => fileSystem.mkdir("/target")),
    recursiveDirectory: await statements(
      (fileSystem) => fileSystem.mkdir("/target/child", true),
      true,
    ),
    rejectedDirectory: await statements(
      (fileSystem) => fileSystem.mkdir("/target/child", true),
      false,
      true,
    ),
  }).toEqual({
    file: 10,
    emptyDirectory: 11,
    recursiveDirectory: 11,
    rejectedDirectory: 4,
  });
});

it("does not touch the change table while its cursor is disabled", async () => {
  async function statements(recordChanges: boolean): Promise<number> {
    const { fileSystem, meter } = meteredFileSystem({ recordChanges });
    await fileSystem.mkdir("/tree/inner", true);
    for (let index = 0; index < 8; index += 1) {
      await fileSystem.writeFile(`/tree/inner/f${index}`, "x");
    }
    meter.reset();
    await fileSystem.writeFile("/tree/inner/f0", "y");
    fileSystem.setMetadata("/tree/inner/f1", { mode: 0o600 });
    await fileSystem.copy("/tree", "/copy", { recursive: true });
    await fileSystem.move("/copy", "/moved");
    await fileSystem.remove("/moved", { recursive: true });
    return meter.statements;
  }

  // Live token updates ride the entry writes themselves. The opt-in cursor
  // records its independent latest-path rows, while the default path performs
  // no statement against that table at all.
  const off = await statements(false);
  const on = await statements(true);
  expect(off).toBe(41);
  expect(on).toBe(47);
});

it("reads a catch-up page with one indexed query", async () => {
  const { fileSystem, meter } = meteredFileSystem({ recordChanges: true });
  for (let index = 0; index < 200; index += 1) {
    await fileSystem.writeFile(`/f${index}`, "x");
  }
  meter.reset();
  const page = fileSystem.changesSince(0, { limit: 50 });
  expect(page.changes).toHaveLength(50);
  expect(page.more).toBe(true);
  // One statement however many entries the page carries: the change row
  // records presence directly, without a lookup per path.
  expect(meter.statements).toBe(1);
});
