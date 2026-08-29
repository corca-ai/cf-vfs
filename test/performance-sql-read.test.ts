import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { WriteFileOptions } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";
import { meteredFileSystem, type SqlMeter } from "./helpers/performance.js";

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

it("caches a file digest by revision without taxing ordinary metadata reads", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  await fileSystem.writeFile("/digest", "x".repeat(8 * 1024));

  meter.reset();
  const cold = await fileSystem.digestFile("/digest");
  const coldCost = { statements: meter.statements, rows: meter.rows };
  meter.reset();
  expect(await fileSystem.digestFile("/digest")).toBe(cold);
  const warmCost = { statements: meter.statements, rows: meter.rows };
  meter.reset();
  fileSystem.stat("/digest");
  const statCost = { statements: meter.statements, rows: meter.rows };
  await fileSystem.writeFile("/primed", "body", { skipIfUnchanged: true });
  meter.reset();
  await fileSystem.digestFile("/primed");
  const sharedWriteDigestCost = { statements: meter.statements, rows: meter.rows };

  expect(coldCost).toEqual({ statements: 3, rows: 2 });
  expect(warmCost).toEqual({ statements: 1, rows: 1 });
  expect(statCost).toEqual({ statements: 1, rows: 1 });
  expect(sharedWriteDigestCost).toEqual({ statements: 1, rows: 1 });
});

it("reuses cached digests across a many-file sha256sum", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  const paths: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const path = `/digest-${index}`;
    paths.push(path);
    await fileSystem.writeFile(path, `${index}:`.padEnd(8 * 1024, "x"));
  }
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  const script = `sha256sum ${paths.join(" ")}`;

  meter.reset();
  const cold = await shell.executeText({ script });
  const coldCost = { statements: meter.statements, rows: meter.rows };
  meter.reset();
  const warm = await shell.executeText({ script });
  const warmCost = { statements: meter.statements, rows: meter.rows };

  expect(cold).toMatchObject({ exitCode: 0, stderr: "" });
  expect(warm).toEqual(cold);
  expect(coldCost).toEqual({ statements: 300, rows: 200 });
  expect(warmCost).toEqual({ statements: 100, rows: 100 });
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
