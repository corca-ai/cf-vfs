import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import type { TestWorkspaceVfs } from "../test/worker.js";
import { meterSqlStorage, type SqlMeter } from "./metered-sql.js";

class BenchmarkFileSystem extends DurableObjectFileSystem {
  armMaintenance(): Promise<void> {
    return this.scheduleGarbageAlarm();
  }
}

const expectedCosts: Record<string, { statements: number; rowsRead: number; rowsWritten: number }> =
  {
    "batch-create-10": { statements: 52, rowsRead: 52, rowsWritten: 41 },
    "batch-create-100": { statements: 502, rowsRead: 502, rowsWritten: 401 },
    "append-string": { statements: 6, rowsRead: 7, rowsWritten: 3 },
    "append-bytes": { statements: 7, rowsRead: 7, rowsWritten: 3 },
    "find-shallow": { statements: 2, rowsRead: 52, rowsWritten: 0 },
    "find-filtered": { statements: 2, rowsRead: 5051, rowsWritten: 0 },
    "find-all": { statements: 7, rowsRead: 5061, rowsWritten: 0 },
    "maintenance-1000": { statements: 1, rowsRead: 4, rowsWritten: 0 },
    "maintenance-10000": { statements: 1, rowsRead: 4, rowsWritten: 0 },
  };

async function measure(name: string, meter: SqlMeter, operation: () => unknown | Promise<unknown>) {
  for (let i = 0; i < 3; i += 1) await operation();
  const durations: number[] = [];
  const repeats = name.startsWith("append-") || name.startsWith("maintenance-") ? 100 : 10;
  for (let sample = 0; sample < 11; sample += 1) {
    const started = performance.now();
    for (let i = 0; i < repeats; i += 1) await operation();
    durations.push((performance.now() - started) / repeats);
  }
  durations.sort((a, b) => a - b);
  meter.reset();
  await operation();
  const result = {
    name,
    repeatsPerSample: repeats,
    medianMs: durations[5],
    p10Ms: durations[1],
    p90Ms: durations[9],
    statements: meter.statements,
    rowsRead: meter.rowsRead,
    rowsWritten: meter.rowsWritten,
  };
  const expected = expectedCosts[name];
  if (expected === undefined) throw new Error(`missing SQL budget for ${name}`);
  expect(result).toMatchObject(expected);
  console.log("SQL optimization:", JSON.stringify(result));
  return result;
}

it.each([10, 100])("SQL batch creation: %s files", async (count) => {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(`sql-batch-${count}`);
  await runInDurableObject(stub, async (_instance, state) => {
    const meter = meterSqlStorage(state.storage);
    const fs = new BenchmarkFileSystem(meter.storage);
    let batch = 0;
    await measure(`batch-create-${count}`, meter, async () => {
      batch += 1;
      const results = await fs.writeFiles(
        Array.from({ length: count }, (_, i) => ({ path: `/b${batch}-${i}`, body: "x" })),
      );
      expect(results).toHaveLength(count);
      expect(results.every((result) => result.created && result.sizeBytes === 1)).toBe(true);
    });
  });
});

it.each(["string", "bytes"])("SQL append: %s", async (kind) => {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(`sql-append-${kind}`);
  await runInDurableObject(stub, async (_instance, state) => {
    const meter = meterSqlStorage(state.storage);
    const fs = new BenchmarkFileSystem(meter.storage);
    await fs.writeFile("/body", "x".repeat(8192));
    let size = 8192;
    const body = kind === "string" ? "y" : new Uint8Array([121]);
    await measure(`append-${kind}`, meter, async () => {
      const result = await fs.appendFile("/body", body);
      size += 1;
      expect(result.sizeBytes).toBe(size);
    });
  });
});

it("SQL filtered and shallow find", async () => {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName("sql-find");
  await runInDurableObject(stub, async (_instance, state) => {
    const meter = meterSqlStorage(state.storage);
    const fs = new BenchmarkFileSystem(meter.storage);
    await fs.writeFiles(
      Array.from({ length: 5000 }, (_, i) => ({
        path: `/tree/d${i % 50}/${i % 100 === 0 ? "target" : "other"}${i}.txt`,
        body: "x",
      })),
      { createParents: true },
    );
    for (const [name, options, count] of [
      ["find-shallow", { maxDepth: 1 }, 50],
      ["find-filtered", { name: "target*", type: "file" as const }, 50],
      ["find-all", {}, 5050],
    ] as const) {
      await measure(name, meter, () => {
        const entries = fs.find({ path: "/tree", ...options });
        expect(entries).toHaveLength(count);
      });
    }
  });
});

it.each([1000, 10000])("SQL maintenance scheduling: %s pending rows per table", async (count) => {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
    `sql-maintenance-${count}`,
  );
  await runInDurableObject(stub, async (_instance, state) => {
    const meter = meterSqlStorage(state.storage);
    const fs = new BenchmarkFileSystem(meter.storage);
    const future = Date.now() + 86400000;
    state.storage.transactionSync(() => {
      for (let i = 0; i < count; i += 1) {
        state.storage.sql.exec(
          "INSERT INTO vfs_gc_queue(r2_key,not_before_ms,next_attempt_at_ms) VALUES (?,?,?)",
          `key-${i}`,
          future + i,
          future + i + 100,
        );
        state.storage.sql.exec(
          `INSERT INTO vfs_upload_sessions(id,path,expected_mutation_token,r2_key,state,expires_at_ms,verification_lease_until_ms,create_parents,mode)
          VALUES(?,?,?,?,?,?,?,0,420)`,
          `id-${i}`,
          `/f${i}`,
          "token",
          `upload-${i}`,
          ["open", "verifying", "committed"][i % 3],
          future + i,
          future + i,
        );
      }
    });
    await measure(`maintenance-${count}`, meter, () => fs.armMaintenance());
    expect(await state.storage.getAlarm()).toBe(future);
    meter.reset();
    meter.storage.sql.exec(
      "INSERT INTO vfs_gc_queue(r2_key,not_before_ms,next_attempt_at_ms) VALUES (?,?,?)",
      "extra",
      future,
      future,
    );
    console.log(
      "SQL optimization:",
      JSON.stringify({
        name: `gc-insert-${count}`,
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
        databaseBytes: state.storage.sql.databaseSize,
      }),
    );
  });
});
