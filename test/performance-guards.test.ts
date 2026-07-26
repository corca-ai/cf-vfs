import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { NodeSqlFileSystem } from "../src/testing/node.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { putOpaque } from "../src/vfs/opaque.js";
import type { OpaqueStore } from "../src/vfs/types.js";
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

function meteredFileSystem(): { fileSystem: NodeSqlFileSystem; meter: SqlMeter } {
  const meter: SqlMeter = {
    statements: 0,
    rows: 0,
    reset() {
      meter.statements = 0;
      meter.rows = 0;
    },
  };
  const fileSystem = createTestFileSystem({
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
    // Two result pages cost the same two statements each as the trusted path.
    // Traversal, root classification, and the set-based permission preflight
    // are paid once for the whole materializing find(), not once per page.
    expect(meter.statements).toBe(7);
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
      write: 15,
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
