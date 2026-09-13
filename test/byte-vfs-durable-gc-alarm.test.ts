import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { RemoteBenchmarkHarness } from "../bench/remote-suite.js";
import { R2OpaqueStore } from "../src/storage/r2.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";

it("stops rearming undeletable garbage and preserves it for a configured collector", async () => {
  const stub = env.VFS_TEST.getByName("gc-without-store");
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new R2OpaqueStore(env.VFS_TEST_BUCKET);
    const configured = new DurableObjectFileSystem(state.storage, { opaqueStore: store });
    const upload = await configured.beginOpaqueUpload("/asset");
    await store.putIfAbsent(upload.objectKey, "body");
    await configured.commitOpaqueUpload(upload.uploadId);
    await configured.remove("/asset");
    // Isolate the deletion deadline from the committed receipt's later expiry.
    state.storage.sql.exec("DELETE FROM vfs_upload_sessions WHERE state = 'committed'");
    const metadataOnly = new DurableObjectFileSystem(state.storage);
    // A running Cloudflare alarm observes null until it explicitly rearms itself.
    await state.storage.deleteAlarm();
    expect(await metadataOnly.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
    expect(await state.storage.getAlarm()).toBeNull();
    expect(await metadataOnly.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
    expect(await state.storage.getAlarm()).toBeNull();
    expect(await store.head(upload.objectKey)).not.toBeNull();
    expect(await configured.drainGarbage()).toEqual({ deleted: 1, remaining: 0 });
    expect(await store.head(upload.objectKey)).toBeNull();
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("still schedules upload expiry when undeletable garbage is already overdue", async () => {
  const stub = env.VFS_TEST.getByName("gc-without-store-expiry");
  await runInDurableObject(stub, async (_instance, state) => {
    const uploader = new DurableObjectFileSystem(state.storage, {
      opaqueStore: new R2OpaqueStore(env.VFS_TEST_BUCKET),
    });
    const fileSystem = new DurableObjectFileSystem(state.storage, { uploadSettlementGraceMs: 1 });
    const abandoned = await uploader.beginOpaqueUpload("/abandoned");
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET expires_at_ms = 1 WHERE id = ?",
      abandoned.uploadId,
    );
    const future = await uploader.beginOpaqueUpload("/future");
    await state.storage.deleteAlarm();
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
    expect(await state.storage.getAlarm()).toBe(future.expiresAtMs);
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET expires_at_ms = 1 WHERE id = ?",
      future.uploadId,
    );
    await state.storage.deleteAlarm();
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 0, remaining: 2 });
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("does not replace an earlier host alarm with an undeletable GC deadline", async () => {
  const stub = env.VFS_TEST.getByName("gc-without-store-host");
  await runInDurableObject(stub, async (_instance, state) => {
    const uploader = new DurableObjectFileSystem(state.storage, {
      opaqueStore: new R2OpaqueStore(env.VFS_TEST_BUCKET),
    });
    const fileSystem = new DurableObjectFileSystem(state.storage, { uploadSettlementGraceMs: 1 });
    const upload = await uploader.beginOpaqueUpload("/abandoned");
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET expires_at_ms = 1 WHERE id = ?",
      upload.uploadId,
    );
    const hostDeadline = Date.now() + 60_000;
    await state.storage.setAlarm(hostDeadline);
    await fileSystem.drainGarbage();
    expect(await state.storage.getAlarm()).toBe(hostDeadline);
  });
});

it("connects the benchmark alarm collector to its R2 bucket", async () => {
  const stub = env.VFS_TEST.getByName("benchmark-gc-bucket");
  const key = await runInDurableObject(stub, async (_instance, state) => {
    const uploader = new DurableObjectFileSystem(state.storage, {
      opaqueStore: new R2OpaqueStore(env.VFS_TEST_BUCKET),
    });
    const upload = await uploader.beginOpaqueUpload("/interrupted");
    await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET expires_at_ms = 1 WHERE id = ?",
      upload.uploadId,
    );
    await state.storage.deleteAlarm();
    const benchmark = new RemoteBenchmarkHarness(state.storage, env.VFS_TEST_BUCKET);
    await benchmark.drainGarbage();
    expect(await state.storage.getAlarm()).toBeNull();
    expect(state.storage.sql.exec("SELECT r2_key FROM vfs_gc_queue").toArray()).toEqual([]);
    return upload.objectKey;
  });
  expect(await env.VFS_TEST_BUCKET.head(key)).toBeNull();
});
