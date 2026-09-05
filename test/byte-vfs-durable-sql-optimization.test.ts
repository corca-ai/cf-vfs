import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import type { TestWorkspaceVfs } from "./worker.js";

class MaintenanceFileSystem extends DurableObjectFileSystem {
  arm(): Promise<void> {
    return this.scheduleGarbageAlarm();
  }
}

it("migrates populated maintenance tables and preserves the earliest shared alarm", async () => {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(
    "sql-maintenance-migration",
  );
  await runInDurableObject(stub, async (_instance, state) => {
    const initial = new MaintenanceFileSystem(state.storage);
    await initial.writeFile("/kept", "body");
    const token = initial.getMutationToken("/kept");
    const base = Date.now() + 86400000;
    state.storage.sql.exec(
      "INSERT INTO vfs_gc_queue(r2_key,not_before_ms,next_attempt_at_ms) VALUES ('gc',?,?)",
      base + 500,
      base + 800,
    );
    for (const [kind, offset, lease] of [
      ["open", 700, null],
      ["verifying", 1, base + 600],
      ["committed", 900, null],
      ["garbage", 0, null],
    ] as const) {
      state.storage.sql.exec(
        `INSERT INTO vfs_upload_sessions(id,path,expected_mutation_token,r2_key,state,expires_at_ms,verification_lease_until_ms,create_parents,mode)
        VALUES(?,?,?,?,?,?,?,0,420)`,
        kind,
        "/kept",
        token,
        kind,
        kind,
        base + offset,
        lease,
      );
    }
    state.storage.sql.exec(
      "DROP INDEX vfs_gc_earliest; DROP INDEX vfs_upload_verification_expiry; DELETE FROM vfs_schema_migrations WHERE version = 8",
    );
    const migrated = new MaintenanceFileSystem(state.storage);
    expect(migrated.getMutationToken("/kept")).toBe(token);
    expect(
      state.storage.sql
        .exec<{ version: number }>("SELECT MAX(version) AS version FROM vfs_schema_migrations")
        .one().version,
    ).toBe(8);
    await state.storage.setAlarm(base + 400);
    await migrated.arm();
    expect(await state.storage.getAlarm()).toBe(base + 400);
    await state.storage.deleteAlarm();
    await migrated.arm();
    expect(await state.storage.getAlarm()).toBe(base + 600);
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET verification_lease_until_ms = NULL WHERE state = 'verifying'",
    );
    await state.storage.deleteAlarm();
    await migrated.arm();
    expect(await state.storage.getAlarm()).toBe(base + 700);
    state.storage.sql.exec("DELETE FROM vfs_upload_sessions; DELETE FROM vfs_gc_queue");
    await migrated.arm();
    expect(await state.storage.getAlarm()).toBe(base + 700);
  });
});
