import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestWorkspaceVfs } from "../test/worker.js";
import { meterSqlStorage } from "./metered-sql.js";

type Layout = "split" | "separated";

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;
}

async function measure(layout: Layout) {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
    `token-schema-spike-${layout}-v1`,
  );
  return await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    const sql = state.storage.sql;
    if (layout === "split") {
      sql.exec(`
        CREATE TABLE entries (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
          parent_path TEXT NOT NULL, name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL, mode INTEGER NOT NULL,
          modified_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX entries_parent_name ON entries(parent_path, name);
        CREATE TABLE versions (
          path TEXT PRIMARY KEY, version INTEGER NOT NULL
        ) WITHOUT ROWID;
      `);
      sql.exec(`
        WITH RECURSIVE seq(i) AS (
          VALUES(0) UNION ALL SELECT i + 1 FROM seq WHERE i < 9999
        )
        INSERT INTO entries
        SELECT i + 1, printf('/src/file-%06d.ts', i), '/src',
               printf('file-%06d.ts', i), 8192, 420, 0, 1
        FROM seq;
      `);
      sql.exec("INSERT INTO versions SELECT path, 1 FROM entries");
    } else {
      sql.exec(`
        CREATE TABLE entries (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
          parent_path TEXT NOT NULL, name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL, mode INTEGER NOT NULL,
          modified_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL,
          mutation_version INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX entries_parent_name ON entries(parent_path, name);
        CREATE TABLE tombstones (
          path TEXT PRIMARY KEY, version INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE changes (
          path TEXT PRIMARY KEY, change_seq INTEGER NOT NULL, present INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX changes_seq ON changes(change_seq, path);
      `);
      sql.exec(`
        WITH RECURSIVE seq(i) AS (
          VALUES(0) UNION ALL SELECT i + 1 FROM seq WHERE i < 9999
        )
        INSERT INTO entries
        SELECT i + 1, printf('/src/file-%06d.ts', i), '/src',
               printf('file-%06d.ts', i), 8192, 420, 0, 1, 1
        FROM seq;
      `);
    }
    sql.exec("PRAGMA optimize");

    const meter = meterSqlStorage(state.storage);
    const statDurations: number[] = [];
    const listDurations: number[] = [];
    const updateDurations: number[] = [];
    const costs: Record<string, { statements: number; rowsRead: number; rowsWritten: number }> = {};

    for (let repeat = 0; repeat < 5; repeat += 1) {
      meter.reset();
      let started = performance.now();
      for (let index = 0; index < 10_000; index += 1) {
        const path = `/src/file-${String((index * 7919) % 10_000).padStart(6, "0")}.ts`;
        if (layout === "split") {
          meter.storage.sql
            .exec(
              `SELECT e.id, e.size_bytes, e.mode, e.revision, v.version
               FROM entries e CROSS JOIN versions v
               WHERE e.path = ? AND v.path = e.path`,
              path,
            )
            .one();
        } else {
          meter.storage.sql
            .exec(
              `SELECT id, size_bytes, mode, revision, mutation_version
               FROM entries WHERE path = ?`,
              path,
            )
            .one();
        }
      }
      statDurations.push(performance.now() - started);
      if (repeat === 0) {
        costs["stat"] = {
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        };
      }

      meter.reset();
      started = performance.now();
      for (let page = 0; page < 500; page += 1) {
        const cursor = page === 0 ? "" : `file-${String(page * 19).padStart(6, "0")}.ts`;
        if (layout === "split") {
          meter.storage.sql
            .exec(
              `SELECT e.path, e.size_bytes, e.mode, e.revision, v.version
               FROM entries e INDEXED BY entries_parent_name
               CROSS JOIN versions v
               WHERE e.parent_path = '/src' AND e.name > ? AND v.path = e.path
               ORDER BY e.name LIMIT 100`,
              cursor,
            )
            .toArray();
        } else {
          meter.storage.sql
            .exec(
              `SELECT path, size_bytes, mode, revision, mutation_version
               FROM entries INDEXED BY entries_parent_name
               WHERE parent_path = '/src' AND name > ?
               ORDER BY name LIMIT 100`,
              cursor,
            )
            .toArray();
        }
      }
      listDurations.push(performance.now() - started);
      if (repeat === 0) {
        costs["list"] = {
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        };
      }

      meter.reset();
      started = performance.now();
      for (let index = 0; index < 5_000; index += 1) {
        const path = `/src/file-${String((index * 7919) % 10_000).padStart(6, "0")}.ts`;
        if (layout === "split") {
          meter.storage.sql.exec(
            "UPDATE entries SET modified_at_ms = modified_at_ms + 1, revision = revision + 1 WHERE path = ?",
            path,
          );
          meter.storage.sql
            .exec(
              "UPDATE versions SET version = version + 1 WHERE path = ? RETURNING version",
              path,
            )
            .one();
        } else {
          meter.storage.sql
            .exec(
              `UPDATE entries SET modified_at_ms = modified_at_ms + 1,
                 revision = revision + 1, mutation_version = mutation_version + 1
               WHERE path = ? RETURNING mutation_version`,
              path,
            )
            .one();
        }
      }
      updateDurations.push(performance.now() - started);
      if (repeat === 0) {
        costs["update"] = {
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        };
      }
    }

    return {
      layout,
      databaseBytes: state.storage.sql.databaseSize,
      statMs: median(statDurations),
      listMs: median(listDurations),
      updateMs: median(updateDurations),
      costs,
    };
  });
}

describe("token schema workerd spike", () => {
  it("compares split and separated live-token layouts", async () => {
    const split = await measure("split");
    const separated = await measure("separated");
    console.info(`token schema workerd spike: ${JSON.stringify({ split, separated })}`);
    expect(separated.databaseBytes).toBeLessThan(split.databaseBytes);
    expect(separated.costs["stat"]).toEqual({
      statements: 10_000,
      rowsRead: 10_000,
      rowsWritten: 0,
    });
    expect(split.costs["stat"]?.rowsRead).toBe(20_000);
    expect(separated.costs["list"]?.rowsRead).toBe(50_000);
    expect(split.costs["list"]?.rowsRead).toBe(100_000);
    expect(separated.costs["update"]).toEqual({
      statements: 5_000,
      rowsRead: 10_000,
      rowsWritten: 5_000,
    });
    expect(split.costs["update"]).toEqual({
      statements: 10_000,
      rowsRead: 15_000,
      rowsWritten: 10_000,
    });
    for (const value of [
      split.statMs,
      split.listMs,
      split.updateMs,
      separated.statMs,
      separated.listMs,
      separated.updateMs,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
