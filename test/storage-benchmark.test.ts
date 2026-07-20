import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { meterSqlStorage } from "./helpers/metered-sql.js";
import type { TestWorkspaceVfs } from "./worker.js";
import { env } from "cloudflare:workers";

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
        "SELECT COUNT(*) AS count FROM vfs2_inline_chunks WHERE entry_id = (SELECT id FROM vfs2_entries WHERE path = '/body')",
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
    expect(metrics.databaseBytesAfter).toBeGreaterThanOrEqual(metrics.databaseBytesBefore);
    expect(metrics.estimatedSqlRowUsd).toBeGreaterThan(0);
  });
});
