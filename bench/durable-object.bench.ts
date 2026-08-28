import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type { TestWorkspaceVfs } from "../test/worker.js";
import { meterSqlStorage } from "./metered-sql.js";

async function averageDuration(
  warmups: number,
  repeats: number,
  operation: () => void | Promise<void>,
): Promise<number> {
  for (let index = 0; index < warmups; index += 1) await operation();
  let elapsed = 0;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    await operation();
    elapsed += performance.now() - started;
  }
  return elapsed / repeats;
}

/**
 * Asserts a duration was measured, without asserting that time passed.
 *
 * An operation fast enough to fall inside the clock's resolution reports zero,
 * and on a shared runner that is a normal reading rather than a broken one —
 * more so as these operations get cheaper. What is worth guarding is that the
 * benchmark ran and produced a number; the costs it exists to hold are the
 * statement and row counts, which do not depend on a clock.
 */
function measured(durationMs: number): void {
  expect(Number.isFinite(durationMs)).toBe(true);
  expect(durationMs).toBeGreaterThanOrEqual(0);
}

describe("Durable Object storage benchmark metrics", () => {
  it("records density and random-read costs for 8–12 KiB inline blobs", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-small-blobs",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fileSystem = new DurableObjectFileSystem(meter.storage);
      const fileCount = 512;
      const sizes = Array.from(
        { length: fileCount },
        (_unused, index) => 8 * 1024 + ((index * 997) % (4 * 1024 + 1)),
      );
      const logicalBytes = sizes.reduce((total, size) => total + size, 0);

      meter.reset();
      let started = performance.now();
      for (const [index, size] of sizes.entries()) {
        const body = new Uint8Array(size);
        body.fill(index % 251);
        await fileSystem.writeFile(`/blob-${index}`, body);
      }
      const writeMs = performance.now() - started;
      const writeCost = {
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      };

      meter.reset();
      started = performance.now();
      let checksum = 0;
      for (let order = 0; order < fileCount; order += 1) {
        const index = (order * 257) % fileCount;
        const body = await readAllBytes(fileSystem.readFile(`/blob-${index}`).stream, 12 * 1024);
        checksum += (body[0] ?? 0) + (body.at(-1) ?? 0);
      }
      const readMs = performance.now() - started;
      const readCost = {
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      };
      const databaseBytes = state.storage.sql.databaseSize;
      const chunks = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_inline_chunks")
        .one().count;
      return {
        fileCount,
        logicalBytes,
        databaseBytes,
        storageAmplification: databaseBytes / logicalBytes,
        chunks,
        checksum,
        writeMs,
        readMs,
        writeCost,
        readCost,
      };
    });

    console.info(`DO small-BLOB benchmark: ${JSON.stringify(metrics)}`);
    expect(metrics).toMatchObject({
      fileCount: 512,
      chunks: 512,
    });
    expect(metrics.logicalBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(metrics.databaseBytes).toBeGreaterThan(metrics.logicalBytes);
    expect(metrics.storageAmplification).toBeLessThan(2);
    expect(metrics.checksum).toBeGreaterThan(0);
    expect(metrics.writeCost).toEqual({
      statements: 3_584,
      rowsRead: 3_584,
      rowsWritten: 3_072,
    });
    expect(metrics.readCost).toEqual({
      statements: 1_024,
      rowsRead: 2_047,
      rowsWritten: 0,
    });
  });

  it("records SQL billing rows and database size for a 1 MiB overwrite", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-inline-overwrite",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fileSystem = new DurableObjectFileSystem(meter.storage, {
        chunkBytes: 256 * 1024,
      });
      meter.reset();
      await fileSystem.writeFile("/body", new Uint8Array(1024 * 1024));
      meter.reset();
      const databaseBytesBefore = state.storage.sql.databaseSize;
      const replacement = new Uint8Array(1024 * 1024);
      replacement[0] = 7;
      await fileSystem.writeFile("/body", replacement);
      const snapshot = fileSystem.readFile("/body");
      const body = await readAllBytes(snapshot.stream, replacement.byteLength);
      const rowsRead = meter.rowsRead;
      const rowsWritten = meter.rowsWritten;
      const chunks = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM vfs_inline_chunks WHERE entry_id = (SELECT id FROM vfs_entries WHERE path = '/body')",
        )
        .one().count;
      return {
        rowsRead,
        rowsWritten,
        databaseBytesBefore,
        databaseBytesAfter: state.storage.sql.databaseSize,
        chunks,
        outputBytes: body.byteLength,
        firstByte: body[0],
        // Marginal paid-plan rates beyond included rows, 2026-07-20.
        // https://developers.cloudflare.com/durable-objects/platform/pricing/
        estimatedSqlRowUsd: (rowsRead * 0.001) / 1_000_000 + (rowsWritten * 1.0) / 1_000_000,
      };
    });

    console.info(`DO storage benchmark: ${JSON.stringify(metrics)}`);
    expect(metrics).toMatchObject({ chunks: 4, outputBytes: 1024 * 1024, firstByte: 7 });
    expect(metrics.rowsRead).toBeGreaterThan(0);
    expect(metrics.rowsWritten).toBeGreaterThan(0);
    expect(metrics.rowsRead).toBeLessThanOrEqual(27);
    expect(metrics.rowsWritten).toBeLessThanOrEqual(7);
    expect(metrics.databaseBytesAfter).toBeGreaterThanOrEqual(metrics.databaseBytesBefore);
    expect(metrics.estimatedSqlRowUsd).toBeGreaterThan(0);
  });

  it("batches inline chunk statements at 33 rows", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-inline-batches",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fileSystem = new DurableObjectFileSystem(meter.storage, { chunkBytes: 4 });
      const statements: Record<string, number> = {};
      for (const chunks of [1, 33, 34]) {
        meter.reset();
        await fileSystem.writeFile(`/body-${chunks}`, new Uint8Array(chunks * 4));
        statements[String(chunks)] = meter.statements;
      }
      return statements;
    });

    expect(metrics).toEqual({ "1": 7, "33": 7, "34": 8 });
  });

  it("rewrites only the inline tail when appending", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-inline-append",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fileSystem = new DurableObjectFileSystem(meter.storage, { chunkBytes: 4 });
      await fileSystem.writeFile("/body", "abcdefghij");
      meter.reset();
      await fileSystem.appendFile("/body", "klmno");
      const rowsWritten = meter.rowsWritten;
      const chunkSizes = state.storage.sql
        .exec<{ size: number }>(
          `SELECT LENGTH(body) AS size FROM vfs_inline_chunks
         WHERE entry_id = (SELECT id FROM vfs_entries WHERE path = '/body')
         ORDER BY chunk_index`,
        )
        .toArray()
        .map((row) => row.size);
      const body = new TextDecoder().decode(
        await readAllBytes(fileSystem.readFile("/body").stream, 32),
      );
      return { body, chunkSizes, rowsWritten };
    });

    expect(metrics).toMatchObject({
      body: "abcdefghijklmno",
      chunkSizes: [4, 4, 4, 3],
    });
    expect(metrics.rowsWritten).toBeGreaterThan(0);
    expect(metrics.rowsWritten).toBeLessThanOrEqual(6);
  });

  it("measures tail append latency without size-proportional writes", async () => {
    const results: Record<string, { durationMs: number; maxRowsWritten: number }> = {};
    for (const [label, bytes, repeats] of [
      ["1MiB", 1024 * 1024 - 1, 12],
      ["8MiB", 8 * 1024 * 1024 - 1, 6],
    ] as const) {
      const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
        `storage-benchmark-append-${label}`,
      );
      results[label] = await runInDurableObject(stub, async (_instance, state) => {
        const meter = meterSqlStorage(state.storage);
        const fileSystem = new DurableObjectFileSystem(meter.storage);
        const body = new Uint8Array(bytes);
        const durations: number[] = [];
        let maxRowsWritten = 0;
        for (let repeat = 0; repeat < repeats; repeat += 1) {
          const path = `/file-${repeat}`;
          await fileSystem.writeFile(path, body);
          meter.reset();
          const started = performance.now();
          await fileSystem.appendFile(path, Uint8Array.of(1));
          if (repeat >= 2) durations.push(performance.now() - started);
          maxRowsWritten = Math.max(maxRowsWritten, meter.rowsWritten);
        }
        return {
          durationMs: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
          maxRowsWritten,
        };
      });
    }

    console.info(`DO append benchmark: ${JSON.stringify(results)}`);
    expect(results["1MiB"]?.maxRowsWritten).toBeLessThanOrEqual(6);
    expect(results["8MiB"]?.maxRowsWritten).toBeLessThanOrEqual(6);
    measured(results["1MiB"]?.durationMs ?? Number.NaN);
    measured(results["8MiB"]?.durationMs ?? Number.NaN);
  });

  it("keeps subtree copy, move, and remove statement counts constant", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-set-based-subtrees",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fileSystem = new DurableObjectFileSystem(meter.storage, { chunkBytes: 4 });
      for (const [root, files] of [
        ["/small-source", 1],
        ["/large-source", 24],
      ] as const) {
        fileSystem.mkdir(root);
        for (let index = 0; index < files; index += 1) {
          await fileSystem.writeFile(`${root}/file-${index}`, "abcdefgh");
        }
      }

      // Each size measures through its own instance over the same storage.
      // The symlink count is cached per instance and any mutation invalidates
      // it, so sharing one would let the work done for the first size decide
      // what the second one pays — making this a comparison of cache state
      // rather than of how subtree cost answers entry count.
      const mutate = async (size: "small" | "large") => {
        const fileSystem = new DurableObjectFileSystem(meter.storage, { chunkBytes: 4 });
        const source = `/${size}-source`;
        const copy = `/${size}-copy`;
        const movedPath = `/${size}-moved`;

        meter.reset();
        const copied = await fileSystem.copy(source, copy, { recursive: true });
        const copyStatements = meter.statements;

        meter.reset();
        const moved = await fileSystem.move(copy, movedPath);
        const moveCost = { statements: meter.statements, rowsRead: meter.rowsRead };
        const movedBody = new TextDecoder().decode(
          await readAllBytes(fileSystem.readFile(`${movedPath}/file-0`).stream, 16),
        );

        meter.reset();
        const removed = await fileSystem.remove(movedPath, { recursive: true });
        const removeStatements = meter.statements;

        return {
          copied,
          moved,
          movedBody,
          removed,
          moveCost,
          statements: {
            copy: copyStatements,
            move: moveCost.statements,
            remove: removeStatements,
          },
        };
      };

      return {
        small: await mutate("small"),
        large: await mutate("large"),
        rootPaths: fileSystem.list("/").map((entry) => entry.path),
      };
    });

    console.info(`DO subtree benchmark: ${JSON.stringify(metrics.large.statements)}`);
    expect(metrics).toMatchObject({
      small: {
        copied: { copied: 2, opaqueBodiesCopied: 0 },
        moved: { moved: 2 },
        moveCost: { statements: 8, rowsRead: 95 },
        movedBody: "abcdefgh",
        removed: { removed: 2 },
      },
      large: {
        copied: { copied: 25, opaqueBodiesCopied: 0 },
        moved: { moved: 25 },
        moveCost: { statements: 8, rowsRead: 164 },
        movedBody: "abcdefgh",
        removed: { removed: 25 },
      },
      rootPaths: ["/large-source", "/small-source"],
    });
    expect(metrics.large.statements).toEqual(metrics.small.statements);
    expect(metrics.large.statements).toEqual({ copy: 9, move: 8, remove: 9 });
  });

  it("measures subtree latency by entry count", async () => {
    const results: Record<string, { copyMs: number; moveMs: number; removeMs: number }> = {};
    for (const [files, repeats] of [
      [100, 22],
      [1_000, 12],
    ] as const) {
      const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
        `storage-benchmark-subtree-latency-${files}`,
      );
      results[String(files)] = await runInDurableObject(stub, async (_instance, state) => {
        const fileSystem = new DurableObjectFileSystem(state.storage, { chunkBytes: 4 });
        fileSystem.mkdir("/source");
        for (let index = 0; index < files; index += 1) {
          await fileSystem.writeFile(`/source/file-${index}`, "abcdefgh");
        }

        const copyDurations: number[] = [];
        const moveDurations: number[] = [];
        const removeDurations: number[] = [];
        for (let repeat = 0; repeat < repeats; repeat += 1) {
          const started = performance.now();
          await fileSystem.copy("/source", "/copy", { recursive: true });
          const copied = performance.now();
          await fileSystem.move("/copy", "/moved");
          const moved = performance.now();
          await fileSystem.remove("/moved", { recursive: true });
          const removed = performance.now();
          if (repeat >= 2) {
            copyDurations.push(copied - started);
            moveDurations.push(moved - copied);
            removeDurations.push(removed - moved);
          }
        }
        const average = (durations: readonly number[]) =>
          durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
        return {
          copyMs: average(copyDurations),
          moveMs: average(moveDurations),
          removeMs: average(removeDurations),
        };
      });
    }

    console.info(`DO subtree latency: ${JSON.stringify(results)}`);
    for (const result of Object.values(results)) {
      measured(result.copyMs);
      measured(result.moveMs);
      measured(result.removeMs);
    }
  });

  it("guards point-operation cursor and statement costs", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-point-operations",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const measuredFileSystem = new DurableObjectFileSystem(meter.storage);
      const pointBytes = 8 * 1024;
      const pointBodyA = `a${"x".repeat(pointBytes - 1)}`;
      const pointBodyB = `b${"x".repeat(pointBytes - 1)}`;
      let pointToken = (await measuredFileSystem.writeFile("/point", pointBodyA)).mutationToken;

      meter.reset();
      measuredFileSystem.stat("/point");
      const statCost = {
        statements: meter.statements,
        nextCalls: meter.cursorNextCalls,
        toArrayCalls: meter.cursorToArrayCalls,
        oneCalls: meter.cursorOneCalls,
      };

      meter.reset();
      pointToken = (
        await measuredFileSystem.writeFile("/point", pointBodyB, {
          ifMutationToken: pointToken,
        })
      ).mutationToken;
      const overwriteCost = {
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      };

      const timedFileSystem = new DurableObjectFileSystem(state.storage);
      timedFileSystem.mkdir("/search");
      for (let index = 0; index < 1_000; index += 1) {
        await timedFileSystem.writeFile(`/search/file-${index}`, "x");
      }
      meter.reset();
      measuredFileSystem.stat("/point");
      const populatedStatCost = {
        rowsRead: meter.rowsRead,
        statements: meter.statements,
      };
      const statMs = await averageDuration(100, 10_000, () => {
        timedFileSystem.stat("/point");
      });
      let pointBodyFlip = false;
      const overwriteMs = await averageDuration(2, 200, async () => {
        pointBodyFlip = !pointBodyFlip;
        const body = pointBodyFlip ? pointBodyA : pointBodyB;
        pointToken = (
          await timedFileSystem.writeFile("/point", body, {
            ifMutationToken: pointToken,
          })
        ).mutationToken;
      });

      const globFindMs = await averageDuration(2, 50, () => {
        timedFileSystem.findPage({
          path: "/search",
          name: "file-?*",
          pathGlob: "/search/file-*",
          limit: 1_000,
        });
      });
      const warmInitializeMs = await averageDuration(20, 1_000, () => {
        new DurableObjectFileSystem(state.storage);
      });
      const statQueryPlan = state.storage.sql
        .exec<{ detail: string }>(
          `EXPLAIN QUERY PLAN
         SELECT
           e.id, e.path, e.parent_path, e.name, e.kind, e.content_class,
           e.opaque_object_id, e.size_bytes, e.mode, e.created_at_ms,
           e.modified_at_ms, e.revision, p.version AS mutation_version
         FROM vfs_entries e INDEXED BY vfs_entries_path
         CROSS JOIN vfs_path_versions p
         WHERE e.path = ? AND p.path = e.path`,
          "/point",
        )
        .toArray()
        .map((row) => row.detail);

      return {
        statCost,
        populatedStatCost,
        overwriteCost,
        statQueryPlan,
        warmInitializeMs,
        statMs,
        overwriteMs,
        globFindMs,
      };
    });

    console.info(`DO point benchmark: ${JSON.stringify(metrics)}`);
    expect(metrics.statCost).toMatchObject({
      statements: 1,
      nextCalls: 0,
      toArrayCalls: 1,
      oneCalls: 0,
    });
    expect(metrics.populatedStatCost).toEqual({ rowsRead: 2, statements: 1 });
    expect(metrics.overwriteCost).toMatchObject({
      statements: 4,
      rowsRead: 9,
      rowsWritten: 3,
    });
    expect(metrics.statQueryPlan.every((detail) => detail.includes("SEARCH"))).toBe(true);
    measured(metrics.warmInitializeMs);
    measured(metrics.statMs);
    measured(metrics.overwriteMs);
    measured(metrics.globFindMs);
  });
});
