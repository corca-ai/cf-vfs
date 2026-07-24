import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type { TestWorkspaceVfs } from "../test/worker.js";
import { meterSqlStorage } from "./metered-sql.js";
import { env } from "cloudflare:workers";

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

describe("Durable Object storage benchmark metrics", () => {
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
      const chunks = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs_inline_chunks WHERE entry_id = (SELECT id FROM vfs_entries WHERE path = '/body')",
      ).one().count;
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
        estimatedSqlRowUsd: rowsRead * 0.001 / 1_000_000
          + rowsWritten * 1.00 / 1_000_000,
      };
    });

    console.info(`DO storage benchmark: ${JSON.stringify(metrics)}`);
    expect(metrics).toMatchObject({ chunks: 4, outputBytes: 1024 * 1024, firstByte: 7 });
    expect(metrics.rowsRead).toBeGreaterThan(0);
    expect(metrics.rowsWritten).toBeGreaterThan(0);
    expect(metrics.rowsRead).toBeLessThanOrEqual(31);
    expect(metrics.rowsWritten).toBeLessThanOrEqual(11);
    expect(metrics.databaseBytesAfter).toBeGreaterThanOrEqual(metrics.databaseBytesBefore);
    expect(metrics.estimatedSqlRowUsd).toBeGreaterThan(0);
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
      const chunkSizes = state.storage.sql.exec<{ size: number }>(
        `SELECT LENGTH(body) AS size FROM vfs_inline_chunks
         WHERE entry_id = (SELECT id FROM vfs_entries WHERE path = '/body')
         ORDER BY chunk_index`,
      ).toArray().map((row) => row.size);
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
          durationMs: durations.reduce((sum, duration) => sum + duration, 0)
            / durations.length,
          maxRowsWritten,
        };
      });
    }

    console.info(`DO append benchmark: ${JSON.stringify(results)}`);
    expect(results["1MiB"]?.maxRowsWritten).toBeLessThanOrEqual(6);
    expect(results["8MiB"]?.maxRowsWritten).toBeLessThanOrEqual(6);
    expect(results["1MiB"]?.durationMs).toBeGreaterThan(0);
    expect(results["8MiB"]?.durationMs).toBeGreaterThan(0);
  });

  it("keeps subtree copy, move, and remove statement counts constant", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-set-based-subtrees",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fileSystem = new DurableObjectFileSystem(meter.storage, { chunkBytes: 4 });
      for (const [root, files] of [["/small-source", 1], ["/large-source", 24]] as const) {
        fileSystem.mkdir(root);
        for (let index = 0; index < files; index += 1) {
          await fileSystem.writeFile(`${root}/file-${index}`, "abcdefgh");
        }
      }

      const mutate = async (size: "small" | "large") => {
        const source = `/${size}-source`;
        const copy = `/${size}-copy`;
        const movedPath = `/${size}-moved`;

        meter.reset();
        const copied = await fileSystem.copy(source, copy, { recursive: true });
        const copyStatements = meter.statements;

        meter.reset();
        const moved = await fileSystem.move(copy, movedPath);
        const moveStatements = meter.statements;
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
          statements: { copy: copyStatements, move: moveStatements, remove: removeStatements },
        };
      };

      return {
        small: await mutate("small"),
        large: await mutate("large"),
        rootPaths: fileSystem.list("/").map((entry) => entry.path),
      };
    });

    console.info(
      `DO subtree benchmark: ${JSON.stringify(metrics.large.statements)}`,
    );
    expect(metrics).toMatchObject({
      small: {
        copied: { copied: 2, opaqueBodiesCopied: 0 },
        moved: { moved: 2 },
        movedBody: "abcdefgh",
        removed: { removed: 2 },
      },
      large: {
        copied: { copied: 25, opaqueBodiesCopied: 0 },
        moved: { moved: 25 },
        movedBody: "abcdefgh",
        removed: { removed: 25 },
      },
      rootPaths: ["/large-source", "/small-source"],
    });
    expect(metrics.large.statements).toEqual(metrics.small.statements);
    expect(metrics.large.statements).toEqual({ copy: 11, move: 7, remove: 10 });
  });

  it("measures subtree latency by entry count", async () => {
    const results: Record<string, { copyMs: number; moveMs: number; removeMs: number }> = {};
    for (const [files, repeats] of [[100, 22], [1_000, 12]] as const) {
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
          let started = performance.now();
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
        const average = (durations: readonly number[]) => (
          durations.reduce((sum, duration) => sum + duration, 0) / durations.length
        );
        return {
          copyMs: average(copyDurations),
          moveMs: average(moveDurations),
          removeMs: average(removeDurations),
        };
      });
    }

    console.info(`DO subtree latency: ${JSON.stringify(results)}`);
    for (const result of Object.values(results)) {
      expect(result.copyMs).toBeGreaterThan(0);
      expect(result.moveMs).toBeGreaterThan(0);
      expect(result.removeMs).toBeGreaterThan(0);
    }
  });

  it("guards point-operation cursor and statement costs", async () => {
    const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
      "storage-benchmark-point-operations",
    );
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const measuredFileSystem = new DurableObjectFileSystem(meter.storage);
      await measuredFileSystem.writeFile("/point", "abcdefgh");

      meter.reset();
      measuredFileSystem.stat("/point");
      const statCost = {
        statements: meter.statements,
        nextCalls: meter.cursorNextCalls,
        toArrayCalls: meter.cursorToArrayCalls,
        oneCalls: meter.cursorOneCalls,
      };

      meter.reset();
      await measuredFileSystem.writeFile("/point", "abcdefgh");
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
      const overwriteMs = await averageDuration(2, 200, async () => {
        await timedFileSystem.writeFile("/point", "abcdefgh");
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
      const statQueryPlan = state.storage.sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT
           e.id, e.path, e.parent_path, e.name, e.kind, e.content_class,
           e.opaque_object_id, e.size_bytes, e.mode, e.created_at_ms,
           e.modified_at_ms, e.revision, p.version AS mutation_version
         FROM vfs_entries e INDEXED BY vfs_entries_path
         CROSS JOIN vfs_path_versions p
         WHERE e.path = ? AND p.path = e.path`,
        "/point",
      ).toArray().map((row) => row.detail);

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
      statements: 13,
      rowsRead: 19,
      rowsWritten: 5,
    });
    expect(metrics.statQueryPlan.every((detail) => detail.includes("SEARCH"))).toBe(true);
    expect(metrics.warmInitializeMs).toBeGreaterThan(0);
    expect(metrics.statMs).toBeGreaterThan(0);
    expect(metrics.overwriteMs).toBeGreaterThan(0);
    expect(metrics.globFindMs).toBeGreaterThan(0);
  });
});
