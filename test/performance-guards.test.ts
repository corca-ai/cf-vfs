import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { NodeSqlFileSystem, NodeSqlFileSystemOptions } from "../src/testing/node.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { putOpaque } from "../src/vfs/opaque.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type { OpaqueStore, WriteFileOptions } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

/**
 * Structural performance guards.
 *
 * These assert counted work — SQL statements, returned rows, and output chunks
 * — rather than elapsed time, so a regression is a deterministic failure in
 * `npm run check` instead of a noisy number in a benchmark report. Wall-clock
 * scenarios stay in `bench/`.
 *
 * Every upper bound is paired with a lower bound. An assertion that only caps
 * counted work is satisfied by zero, so a meter that silently stopped observing
 * would leave the whole gate green while measuring nothing.
 */

interface SqlMeter {
  statements: number;
  rows: number;
  reset(): void;
}

function meteredFileSystem(options: Omit<NodeSqlFileSystemOptions, "onStatement"> = {}): {
  fileSystem: NodeSqlFileSystem;
  meter: SqlMeter;
} {
  const meter: SqlMeter = {
    statements: 0,
    rows: 0,
    reset() {
      meter.statements = 0;
      meter.rows = 0;
    },
  };
  const fileSystem = createTestFileSystem({
    ...options,
    onStatement: (_query, rows) => {
      meter.statements += 1;
      meter.rows += rows;
    },
  });
  return { fileSystem, meter };
}

async function garbageStatements(
  count: number,
  options: { expireUploads?: boolean; failDelete?: boolean } = {},
): Promise<number> {
  let now = 0;
  const meter: SqlMeter = {
    statements: 0,
    rows: 0,
    reset() {
      meter.statements = 0;
      meter.rows = 0;
    },
  };
  const backing = new MemoryOpaqueStore();
  const store: OpaqueStore =
    options.failDelete === true
      ? {
          putIfAbsent: (...args) => backing.putIfAbsent(...args),
          head: (...args) => backing.head(...args),
          getStream: (...args) => backing.getStream(...args),
          delete: () => Promise.reject(new Error("expected delete failure")),
        }
      : backing;
  const fileSystem = createTestFileSystem({
    opaqueStore: store,
    now: () => now,
    uploadSettlementGraceMs: 1,
    onStatement: (_query, rows) => {
      meter.statements += 1;
      meter.rows += rows;
    },
  });
  for (let index = 0; index < count; index += 1) {
    const path = `/opaque-${index}`;
    if (options.expireUploads === true) {
      await fileSystem.beginOpaqueUpload(path, { expiresInMs: 1 });
    } else {
      await putOpaque(fileSystem, store, path, "x");
      await fileSystem.remove(path);
    }
  }
  now = 2;
  meter.reset();
  try {
    await fileSystem.drainGarbage(count);
  } catch (error) {
    if (
      options.failDelete !== true ||
      !(error instanceof Error) ||
      error.message !== "expected delete failure"
    )
      throw error;
  }
  return meter.statements;
}

async function runChunks(
  fileSystem: NodeSqlFileSystem,
  script: string,
): Promise<{ chunks: number; bytes: number; exitCode: number }> {
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  const execution = shell.executeStream({ script });
  const drain = async (
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ chunks: number; bytes: number }> => {
    const reader = stream.getReader();
    let chunks = 0;
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks += 1;
      bytes += result.value.byteLength;
    }
    return { chunks, bytes };
  };
  const [stdout, , completed] = await Promise.all([
    drain(execution.stdout),
    drain(execution.stderr),
    execution.completed,
  ]);
  return { ...stdout, exitCode: completed.exitCode };
}

describe("output slab batching", () => {
  it("batches many small records into 64 KiB slabs instead of one write each", async () => {
    const fileSystem = createTestFileSystem();
    const records = 20_000;
    await fileSystem.writeFile("/records", "record\n".repeat(records));
    const result = await runChunks(fileSystem, "nl /records");
    expect(result.exitCode).toBe(0);
    // Roughly 290 KiB across 20000 records, so a correct implementation emits a
    // handful of slabs. One chunk per record would be three orders of magnitude
    // more and is the regression this guard exists to catch.
    expect(result.bytes).toBeGreaterThan(256 * 1024);
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.chunks).toBeLessThanOrEqual(Math.ceil(result.bytes / (64 * 1024)) + 1);
  });

  it("keeps a large single write unbuffered rather than splitting it", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/big", "x".repeat(200 * 1024));
    const result = await runChunks(fileSystem, "cat /big");
    expect(result.bytes).toBe(200 * 1024);
    // `cat` streams the inline snapshot, so chunk count tracks storage chunking
    // rather than record count.
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.chunks).toBeLessThanOrEqual(8);
  });
});

describe("common-path SQL cost", () => {
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
    // And a set shares one transaction and one usage read across its entries
    // rather than paying for them once per file.
    expect(batchOfThree).toEqual({ statements: 21, rows: 4 });
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

  it("adds no SQL for mutation notification, observed or not", async () => {
    async function statements(observe: boolean): Promise<number> {
      const meter: SqlMeter = {
        statements: 0,
        rows: 0,
        reset() {
          meter.statements = 0;
          meter.rows = 0;
        },
      };
      const seen: unknown[] = [];
      const fileSystem = createTestFileSystem({
        onStatement: () => {
          meter.statements += 1;
        },
        // The usage event costs a query by design, so it is filtered out here
        // rather than left to make the two arms incomparable.
        ...(observe ? { onEvent: (event) => seen.push(event) } : {}),
      });
      await fileSystem.mkdir("/tree/inner", true);
      for (let index = 0; index < 8; index += 1) {
        await fileSystem.writeFile(`/tree/inner/f${index}`, "x");
      }
      meter.reset();
      seen.length = 0;
      await fileSystem.writeFile("/tree/inner/f0", "y");
      fileSystem.setMetadata("/tree/inner/f1", { mode: 0o600 });
      await fileSystem.copy("/tree", "/copy", { recursive: true });
      await fileSystem.move("/copy", "/moved");
      await fileSystem.remove("/moved", { recursive: true });
      if (observe) {
        expect(
          seen.filter((event) => (event as { type: string }).type === "vfs.mutation"),
        ).toHaveLength(5);
      }
      return meter.statements;
    }

    // Everything the notification carries is already in hand where the token
    // is published, so it runs no query of its own. What the difference below
    // measures is the guarded `usage()` work that feeds `vfs.usage`: one read
    // for the same-size write whose unobserved path skips usage entirely, and
    // one for the other mutations together. The five mutation notifications
    // themselves still add no query.
    const unobserved = await statements(false);
    const observed = await statements(true);
    expect(unobserved).toBe(41);
    expect(observed - unobserved).toBe(2);
  });

  it("charges skipIfUnchanged only where it can decide something", async () => {
    async function statements(
      body: string,
      options: WriteFileOptions,
      warm = false,
    ): Promise<number> {
      const { fileSystem, meter } = meteredFileSystem();
      await fileSystem.writeFile("/snapshot", "body");
      if (warm) await fileSystem.writeFile("/snapshot", "body", { skipIfUnchanged: true });
      meter.reset();
      await fileSystem.writeFile("/snapshot", body, options);
      return meter.statements;
    }

    const off = await statements("body", {});
    const measured = {
      off,
      // The size column already in hand decides a different length, so neither
      // the digest nor the bodies are ever read and the option costs nothing.
      sizeDiffers: await statements("longer body", { skipIfUnchanged: true }),
      // No digest recorded yet, so one lookup that finds none, then the read of
      // the entry's own chunks, and then the ordinary write.
      sameSizeDiffers: await statements("BODY", { skipIfUnchanged: true }),
      // The same lookup and read, then the digest is recorded so no later call
      // has to read the body again, and then nothing at all.
      unchanged: await statements("body", { skipIfUnchanged: true }),
      // With one recorded, the lookup replaces the read rather than preceding
      // it, and there is nothing to record.
      unchangedWarm: await statements("body", { skipIfUnchanged: true }, true),
    };

    // Exact on every arm: an upper bound alone would be satisfied by a meter
    // that stopped observing, and the `off` arm is what proves an optional
    // feature added no statements to the path that does not use it.
    expect(measured).toEqual({
      off: 5,
      sizeDiffers: 8,
      sameSizeDiffers: 8,
      unchanged: 7,
      unchangedWarm: 5,
    });
    // The warm no-op now ties the ordinary overwrite on statements while
    // avoiding every content and metadata write.
    expect(measured.unchangedWarm).toBeLessThanOrEqual(measured.off);
  });

  it("reads by entry identity in one statement, whatever the path costs", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    fileSystem.mkdir("/a/b/c/d/e/f/g/h", true);
    await fileSystem.writeFile("/a/b/c/d/e/f/g/h/deep", "body");
    const ino = fileSystem.stat("/a/b/c/d/e/f/g/h/deep").ino;

    meter.reset();
    fileSystem.statById(ino);
    const byIdentity = { statements: meter.statements, rows: meter.rows };
    meter.reset();
    fileSystem.stat("/a/b/c/d/e/f/g/h/deep");
    const byPath = { statements: meter.statements, rows: meter.rows };

    // `id` is INTEGER PRIMARY KEY, which SQLite makes an alias for the rowid,
    // so this seeks the table's own key and needs no index of its own. Pinned
    // against the path read so a later change that turns it into a scan, or
    // that adds an index to carry it, is a failure rather than a slowdown.
    expect(byIdentity).toEqual({ statements: 1, rows: 1 });
    expect(byIdentity.statements).toBeLessThanOrEqual(byPath.statements);
  });

  it("decides skipIfUnchanged in a constant number of rows however large the body", async () => {
    async function rowsForUnchanged(sizeBytes: number): Promise<number> {
      const { fileSystem, meter } = meteredFileSystem();
      const body = "x".repeat(sizeBytes);
      // The first call records the digest; the steady state is what is pinned.
      await fileSystem.writeFile("/snapshot", body, { skipIfUnchanged: true });
      await fileSystem.writeFile("/snapshot", body, { skipIfUnchanged: true });
      meter.reset();
      await fileSystem.writeFile("/snapshot", body, { skipIfUnchanged: true });
      return meter.rows;
    }

    // A recorded digest decides it without reading the body, so the cost stops
    // following the number of stored chunks. Without one this reads every
    // chunk: a 4 MiB body is 16 of them.
    const measured = {
      oneChunk: await rowsForUnchanged(4 * 1024),
      fourChunks: await rowsForUnchanged(1024 * 1024),
      sixteenChunks: await rowsForUnchanged(4 * 1024 * 1024),
    };
    expect(measured).toEqual({ oneChunk: 3, fourChunks: 3, sixteenChunks: 3 });
  });

  it("lists a directory with one traversal rather than one query per entry", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    fileSystem.mkdir("/many", true);
    for (let index = 0; index < 200; index += 1) {
      await fileSystem.writeFile(`/many/file-${index}`, "x");
    }
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    meter.reset();
    const result = await shell.executeText({ script: "ls /many | wc -l" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("200\n");
    // One stat for the operand plus one listing query. Anything proportional to
    // the entry count means a per-entry lookup crept back in.
    expect(meter.statements).toBeGreaterThan(0);
    expect(meter.statements).toBeLessThanOrEqual(6);
    expect(meter.rows).toBeGreaterThanOrEqual(200);
    expect(meter.rows).toBeLessThanOrEqual(210);
  });

  it("reuses text-edit snapshots and redirection preflights", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    await fileSystem.writeFile("/target", "alpha\n");

    meter.reset();
    expect((await shell.executeText({ script: 'printf "gamma\\n" > /target' })).exitCode).toBe(0);
    expect(meter.statements).toBe(7);

    meter.reset();
    expect((await shell.executeText({ script: "sed -i s/gamma/delta/ /target" })).exitCode).toBe(0);
    expect(meter.statements).toBe(6);

    await fileSystem.writeFile(
      "/change.patch",
      "--- before\n+++ after\n@@ -1 +1 @@\n-delta\n+omega\n",
    );
    meter.reset();
    expect((await shell.executeText({ script: "patch /target /change.patch" })).exitCode).toBe(0);
    expect(meter.statements).toBe(9);
  });

  it("adds only fixed-cost credential checks to a directory listing", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    fileSystem.mkdir("/many");
    for (let index = 0; index < 200; index += 1) {
      await fileSystem.writeFile(`/many/file-${index}`, "x");
    }
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });

    meter.reset();
    expect((await shell.executeText({ script: "ls /many | wc -l" })).stdout).toBe("200\n");
    const trustedStatements = meter.statements;

    meter.reset();
    expect(
      (
        await shell.executeText({
          script: "ls /many | wc -l",
          credentials: { uid: 1_000, gid: 1_000 },
        })
      ).stdout,
    ).toBe("200\n");
    const credentialStatements = meter.statements;
    const credentialRows = meter.rows;
    expect(credentialStatements).toBeGreaterThan(trustedStatements);
    expect(credentialStatements).toBeLessThanOrEqual(trustedStatements + 2);

    for (let index = 200; index < 400; index += 1) {
      await fileSystem.writeFile(`/many/file-${index}`, "x");
    }
    meter.reset();
    expect(
      (
        await shell.executeText({
          script: "ls /many | wc -l",
          credentials: { uid: 1_000, gid: 1_000 },
        })
      ).stdout,
    ).toBe("400\n");
    expect(meter.statements).toBe(credentialStatements);
    expect(meter.rows).toBe(credentialRows + 200);
  });

  it("does not make an unrelated path cost more once a link exists", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    fileSystem.mkdir("/many", true);
    for (let index = 0; index < 200; index += 1) {
      await fileSystem.writeFile(`/many/file-${index}`, "x");
    }
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    meter.reset();
    expect((await shell.executeText({ script: "ls /many | wc -l" })).exitCode).toBe(0);
    const withoutLinks = meter.statements;
    expect(withoutLinks).toBeGreaterThan(0);

    // A link elsewhere in the namespace must not change what this costs.
    // Resolution asks whether any link exists before doing any work, and an
    // operation that resolves keeps the row it landed on rather than looking
    // the same path up again.
    fileSystem.symlink("/elsewhere", "/many");
    meter.reset();
    const linked = await shell.executeText({ script: "ls /many | wc -l" });
    expect(linked.exitCode).toBe(0);
    expect(linked.stdout).toBe("200\n");
    expect(meter.statements).toBe(withoutLinks);

    // Reading through the link costs a fixed amount more — one lookup per hop
    // for each path `ls` resolves — and nothing that grows with the namespace.
    // Doubling the directory must not change the count.
    meter.reset();
    expect((await shell.executeText({ script: "ls /elsewhere | wc -l" })).stdout).toBe("200\n");
    const throughLink = meter.statements;
    expect(throughLink).toBeGreaterThan(withoutLinks);
    for (let index = 200; index < 400; index += 1) {
      await fileSystem.writeFile(`/many/file-${index}`, "x");
    }
    meter.reset();
    expect((await shell.executeText({ script: "ls /elsewhere | wc -l" })).stdout).toBe("400\n");
    expect(meter.statements).toBe(throughLink);
  });

  it("charges no storage work to applet resolution", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    // Prove the meter observes this filesystem before asserting a zero.
    await fileSystem.writeFile("/probe", "x");
    meter.reset();
    await shell.executeText({ script: "cat /probe" });
    expect(meter.statements).toBeGreaterThan(0);

    meter.reset();
    const result = await shell.executeText({
      script: "index=0; while [ $index -lt 200 ]; do true; index=$((index + 1)); done; echo done",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done\n");
    // Resolving a registered applet is a JavaScript map lookup. A PATH search
    // over real namespace entries is a separate, budgeted concern; this guard
    // covers applet resolution and must keep covering it.
    expect(meter.statements).toBe(0);
  });

  it("charges no storage work to a PATH search or to command discovery", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      commandResolution: "path",
    });
    await fileSystem.writeFile("/probe", "x");
    meter.reset();
    await shell.executeText({ script: "cat /probe" });
    expect(meter.statements).toBeGreaterThan(0);

    meter.reset();
    const result = await shell.executeText({
      script: [
        "PATH=/usr/bin:/bin",
        "index=0",
        "while [ $index -lt 100 ]; do true; index=$((index + 1)); done",
        "command -v grep",
        "type cat",
        "which sort",
      ].join("\n"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/usr/bin/grep\ncat is /usr/bin/cat\n/usr/bin/sort\n");
    // A PATH search walks a JavaScript array of components. Discovery reuses
    // the same resolver, so neither may reach storage.
    expect(meter.statements).toBe(0);
  });

  it("resolves a virtual applet path with the same storage cost as a bare name", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    await fileSystem.writeFile("/probe", "x");
    meter.reset();
    await shell.executeText({ script: "cat /probe" });
    expect(meter.statements).toBeGreaterThan(0);

    meter.reset();
    await shell.executeText({ script: "echo bare" });
    const bare = meter.statements;
    meter.reset();
    await shell.executeText({ script: "/bin/echo absolute" });
    expect(meter.statements).toBe(bare);
    expect(bare).toBe(0);
  });

  it("reads an executable script once and charges nothing to a bare applet", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    await fileSystem.writeFile("/w/run.sh", "#!/bin/sh\nprintf ran\n", { createParents: true });
    fileSystem.setMetadata("/w/run.sh", { mode: 0o100755 });
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      commandResolution: "path",
    });

    meter.reset();
    const script = await shell.executeText({ script: "/w/run.sh" });
    expect(script.stdout).toBe("ran");
    // One stat to classify the file plus the inline read. A resolution that
    // probed every PATH component, or read the file twice for the shebang and
    // then for the source, would show up here immediately.
    expect(meter.statements).toBeGreaterThan(0);
    expect(meter.statements).toBeLessThanOrEqual(4);

    // A bare applet name never touches storage, even with the search enabled.
    meter.reset();
    await shell.executeText({ script: "PATH=/bin:/usr/bin printf ok" });
    expect(meter.statements).toBe(0);
  });

  it("walks a subtree with one set-based traversal", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    for (let index = 0; index < 20; index += 1) {
      await fileSystem.writeFile(`/tree/branch-${index}/leaf`, "x", { createParents: true });
    }
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    meter.reset();
    const result = await shell.executeText({ script: "find /tree -type f | wc -l" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("20\n");
    // A JavaScript directory walk would issue one query per directory.
    expect(meter.statements).toBeGreaterThan(0);
    expect(meter.statements).toBeLessThanOrEqual(4);
  });

  it("preflights credential permissions once across materialized find pages", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    fileSystem.mkdir("/tree");
    for (let index = 0; index < 1_005; index += 1) {
      await fileSystem.writeFile(`/tree/file-${index.toString().padStart(4, "0")}`, "x");
    }

    meter.reset();
    const entries = fileSystem
      .forCredentials({ uid: 1_000, gid: 1_000 })
      .find({ path: "/tree", includeRoot: true });
    expect(entries).toHaveLength(1_006);
    // Root classification, traversal, and the set-based permission preflight
    // are paid once for the whole materializing find(), not once per page.
    expect(meter.statements).toBe(5);
  });

  it("keeps credential-bound recursive copy set-based as the subtree grows", async () => {
    const { fileSystem, meter } = meteredFileSystem();
    fileSystem.mkdir("/destination");
    fileSystem.setMetadata("/destination", { mode: 0o040777 });
    for (let index = 0; index < 20; index += 1) {
      await fileSystem.writeFile(`/small/dir-${index}/file`, "x", { createParents: true });
    }
    for (let index = 0; index < 40; index += 1) {
      await fileSystem.writeFile(`/large/dir-${index}/file`, "x", { createParents: true });
    }
    const user = fileSystem.forCredentials({ uid: 1_000, gid: 1_000 });

    meter.reset();
    const small = await user.copy("/small", "/destination/small", { recursive: true });
    const smallStatements = meter.statements;
    expect(smallStatements).toBe(14);

    // Copy conservatively invalidates the symlink-count cache. Refresh it
    // outside both measurements so subtree size is the only variable.
    fileSystem.realpath("/destination/small");
    meter.reset();
    const large = await user.copy("/large", "/destination/large", { recursive: true });
    expect(meter.statements).toBe(smallStatements);
    expect(large.copied).toBeGreaterThan(small.copied);
  });

  it("walks a credential-bound creation parent only once per transaction", async () => {
    async function statements(
      operation: (fileSystem: ReturnType<NodeSqlFileSystem["forCredentials"]>) => unknown,
      root = "/home",
    ): Promise<number> {
      const { fileSystem, meter } = meteredFileSystem();
      fileSystem.mkdir(root);
      fileSystem.setOwnership(root, { uid: 1_000, gid: 1_000 });
      fileSystem.setMetadata(root, { mode: 0o040700 });
      const user = fileSystem.forCredentials({
        uid: 1_000,
        gid: 1_000,
        supplementaryGids: [1_001],
      });
      meter.reset();
      await operation(user);
      return meter.statements;
    }

    expect({
      touch: await statements((fileSystem) => fileSystem.touch("/home/touch")),
      mkdir: await statements((fileSystem) => fileSystem.mkdir("/home/dir")),
      symlink: await statements((fileSystem) => fileSystem.symlink("/home/link", "/target")),
      write: await statements((fileSystem) => fileSystem.writeFile("/home/file", "x")),
      recursiveTouch: await statements(
        (fileSystem) => fileSystem.touch("/deep/a/b/c/file", { createParents: true }),
        "/deep",
      ),
    }).toEqual({
      touch: 9,
      mkdir: 9,
      symlink: 9,
      write: 12,
      recursiveTouch: 21,
    });
  });
});

describe("garbage-collection SQL cost", () => {
  it("keeps successful cleanup constant across a full batch", async () => {
    const one = await garbageStatements(1);
    expect(one).toBeGreaterThan(0);
    expect(await garbageStatements(100)).toBe(one);
  });

  it("keeps failed backoff updates constant across a full batch", async () => {
    const one = await garbageStatements(1, { failDelete: true });
    expect(one).toBeGreaterThan(0);
    expect(await garbageStatements(100, { failDelete: true })).toBe(one);
  });

  it("expires each upload without re-reading its session", async () => {
    const one = await garbageStatements(1, { expireUploads: true });
    expect(one).toBeGreaterThan(0);
    expect(await garbageStatements(100, { expireUploads: true })).toBeLessThanOrEqual(one + 2 * 99);
  });
});
