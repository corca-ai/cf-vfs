import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { R2OpaqueStore } from "../src/storage/r2.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(`byte-${name}`);
}

it("recovers a committed upload receipt idempotently after eviction", async () => {
  const stub = workspace("opaque-commit");
  const upload = await stub.beginOpaqueUpload("/asset", {
    expectedSizeBytes: 4,
    contentType: "application/octet-stream",
  });
  const store = new R2OpaqueStore(env.VFS_TEST_BUCKET);
  await store.putIfAbsent(upload.objectKey, new Uint8Array([1, 2, 3, 4]), {
    contentType: "application/octet-stream",
  });

  const first = await stub.commitOpaqueUpload(upload.uploadId);
  await evictDurableObject(stub);
  const second = await stub.commitOpaqueUpload(upload.uploadId);
  expect(second).toEqual(first);
  expect(first).toMatchObject({
    path: "/asset",
    contentClass: "opaque",
    sizeBytes: 4,
  });
  expect((await env.VFS_TEST_BUCKET.head(upload.objectKey))?.version).not.toBe("");
});

it("uses R2 checksum serialization for verified SHA-256 metadata", async () => {
  const key = `checksum-${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("body"));
  try {
    await env.VFS_TEST_BUCKET.put(key, "body", { sha256: digest });
    await expect(new R2OpaqueStore(env.VFS_TEST_BUCKET).head(key)).resolves.toMatchObject({
      verifiedSha256: "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5",
    });
  } finally {
    await env.VFS_TEST_BUCKET.delete(key);
  }
});

it("returns a transient verification failure to open state and retries safely", async () => {
  const stub = workspace("opaque-head-retry");
  const result = await runInDurableObject(stub, async (_instance, state) => {
    const backing = new MemoryOpaqueStore();
    let rejectNextHead = true;
    const fileSystem = new DurableObjectFileSystem(state.storage, {
      workspaceId: "head-retry",
      opaqueStore: {
        putIfAbsent: (...args) => backing.putIfAbsent(...args),
        head: (...args) => {
          if (rejectNextHead) {
            rejectNextHead = false;
            throw new Error("transient R2 head failure");
          }
          return backing.head(...args);
        },
        getStream: (...args) => backing.getStream(...args),
        delete: (...args) => backing.delete(...args),
      },
    });
    const upload = await fileSystem.beginOpaqueUpload("/asset");
    await backing.putIfAbsent(upload.objectKey, "body");
    let message = "";
    try {
      await fileSystem.commitOpaqueUpload(upload.uploadId);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const afterFailure = state.storage.sql
      .exec<{
        state: string;
        verification_token: string | null;
        verification_lease_until_ms: number | null;
        queued: number;
      }>(
        `SELECT state, verification_token, verification_lease_until_ms,
              (SELECT COUNT(*) FROM vfs_gc_queue WHERE r2_key = s.r2_key) AS queued
       FROM vfs_upload_sessions s WHERE id = ?`,
        upload.uploadId,
      )
      .one();
    const pathsAfterFailure = fileSystem.list("/").map((entry) => entry.path);
    const committed = await fileSystem.commitOpaqueUpload(upload.uploadId);
    return { message, afterFailure, pathsAfterFailure, committed };
  });
  expect(result.message).toBe("transient R2 head failure");
  expect(result.afterFailure).toEqual({
    state: "open",
    verification_token: null,
    verification_lease_until_ms: null,
    queued: 0,
  });
  expect(result.pathsAfterFailure).not.toContain("/asset");
  expect(result.committed).toMatchObject({ path: "/asset", contentClass: "opaque" });
});

it("keeps the previous generation visible until opaque replacement verification commits", async () => {
  const stub = workspace("opaque-publication");
  const result = await runInDurableObject(stub, async (_instance, state) => {
    let markHeadStarted: (() => void) | undefined;
    let releaseHead: (() => void) | undefined;
    const headStarted = new Promise<void>((resolve) => {
      markHeadStarted = resolve;
    });
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const backing = new MemoryOpaqueStore();
    const fileSystem = new DurableObjectFileSystem(state.storage, {
      workspaceId: "opaque-publication",
      opaqueStore: {
        putIfAbsent: (...args) => backing.putIfAbsent(...args),
        async head(key) {
          markHeadStarted?.();
          await headGate;
          return backing.head(key);
        },
        getStream: (...args) => backing.getStream(...args),
        delete: (...args) => backing.delete(...args),
      },
    });
    await fileSystem.writeFile("/asset", "old");
    const upload = await fileSystem.beginOpaqueUpload("/asset");
    await backing.putIfAbsent(upload.objectKey, "new");

    const committing = fileSystem.commitOpaqueUpload(upload.uploadId);
    await headStarted;
    const during = await (async () => {
      try {
        return {
          stat: fileSystem.stat("/asset"),
          body: new TextDecoder().decode(
            await readAllBytes(fileSystem.readFile("/asset").stream, 16),
          ),
        };
      } finally {
        releaseHead?.();
      }
    })();
    const committed = await committing;
    const published = await backing.getStream(upload.objectKey);
    if (published === null) throw new Error("committed opaque generation is missing");
    return {
      during,
      committed,
      after: fileSystem.stat("/asset"),
      body: new TextDecoder().decode(await readAllBytes(published, 16)),
    };
  });

  expect(result.during.stat).toMatchObject({ contentClass: "inline", sizeBytes: 3 });
  expect(result.during.body).toBe("old");
  expect(result.committed).toMatchObject({ contentClass: "opaque", sizeBytes: 3 });
  expect(result.after).toEqual(result.committed);
  expect(result.body).toBe("new");
});

it("validates committed receipts and expires them without removing the file", async () => {
  const stub = workspace("receipt-retention");
  const upload = await stub.beginOpaqueUpload("/asset");
  await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
  await stub.commitOpaqueUpload(upload.uploadId);
  const error = await runInDurableObject(stub, async (instance, state) => {
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET receipt_json = ? WHERE id = ?",
      '{"kind":"file","contentClass":"opaque"}',
      upload.uploadId,
    );
    try {
      await instance.commitOpaqueUpload(upload.uploadId);
      return null;
    } catch (caught) {
      return caught;
    }
  });
  expect(error).toMatchObject({ code: "EIO" });
  const missingIdentityError = await runInDurableObject(stub, async (instance, state) => {
    const receipt = Object.fromEntries(
      Object.entries(instance.stat("/asset")).filter(([field]) => field !== "ino"),
    );
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET receipt_json = ? WHERE id = ?",
      JSON.stringify(receipt),
      upload.uploadId,
    );
    try {
      await instance.commitOpaqueUpload(upload.uploadId);
      return null;
    } catch (caught) {
      return caught;
    }
  });
  expect(missingIdentityError).toMatchObject({ code: "EIO" });
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET expires_at_ms = 0, receipt_json = ? WHERE id = ?",
      JSON.stringify(instance.stat("/asset")),
      upload.uploadId,
    );
    let expired: unknown;
    try {
      await instance.commitOpaqueUpload(upload.uploadId);
    } catch (caught) {
      expired = caught;
    }
    expect(expired).toMatchObject({ code: "ENOENT" });
    expect(
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM vfs_upload_sessions WHERE id = ?",
          upload.uploadId,
        )
        .one().count,
    ).toBe(0);
    expect(instance.stat("/asset")).toMatchObject({ contentClass: "opaque", sizeBytes: 4 });
  });
});

it("defers aborted-upload deletion until upload authority has expired", async () => {
  const stub = workspace("late-upload-settlement");
  const upload = await stub.beginOpaqueUpload("/late", { expiresInMs: 60_000 });
  await stub.abortOpaqueUpload(upload.uploadId);
  await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "late");
  expect(await stub.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
  expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).not.toBeNull();

  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE vfs_gc_queue SET not_before_ms = 0, next_attempt_at_ms = 0 WHERE r2_key = ?",
      upload.objectKey,
    );
  });
  expect(await stub.drainGarbage()).toEqual({ deleted: 1, remaining: 0 });
  expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
});

it("prevents overwriting an immutable R2 generation", async () => {
  const store = new R2OpaqueStore(env.VFS_TEST_BUCKET);
  const key = `one-write/${crypto.randomUUID()}`;
  await store.putIfAbsent(key, "first");
  await expect(store.putIfAbsent(key, "second")).rejects.toMatchObject({
    code: "EEXIST",
    path: key,
  });
});

it("uses namespace-derived liveness for opaque copies and batched GC", async () => {
  const stub = workspace("opaque-copy-gc");
  const upload = await stub.beginOpaqueUpload("/asset");
  await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
  await stub.commitOpaqueUpload(upload.uploadId);

  expect(await stub.copy("/asset", "/copy")).toMatchObject({
    copied: 1,
    opaqueBodiesCopied: 0,
  });
  expect(await stub.remove("/asset")).toMatchObject({
    opaqueObjectsQueuedForDeletion: 0,
  });
  expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).not.toBeNull();
  expect(await stub.remove("/copy")).toMatchObject({
    opaqueObjectsQueuedForDeletion: 1,
  });
  expect(await stub.drainGarbage()).toMatchObject({ deleted: 1, remaining: 0 });
  expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
});

it("blocks absent-path ABA from committing a stale upload", async () => {
  const stub = workspace("opaque-aba");
  const upload = await stub.beginOpaqueUpload("/future");
  await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
  await stub.writeFile("/future", "temporary");
  await stub.remove("/future");

  const commitError = await runInDurableObject(stub, async (instance) => {
    try {
      await instance.commitOpaqueUpload(upload.uploadId);
      return null;
    } catch (error) {
      return error;
    }
  });
  expect(commitError).toMatchObject({ code: "EREVISION", path: "/future" });
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE vfs_gc_queue SET not_before_ms = 0, next_attempt_at_ms = 0 WHERE r2_key = ?",
      upload.objectKey,
    );
  });
  await stub.drainGarbage();
  expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
});

it("keeps a leased opaque generation readable after replacement and eviction", async () => {
  const stub = workspace("opaque-read-lease");
  const upload = await stub.beginOpaqueUpload("/asset");
  const store = new R2OpaqueStore(env.VFS_TEST_BUCKET);
  await store.putIfAbsent(upload.objectKey, "old");
  await stub.commitOpaqueUpload(upload.uploadId);
  const lease = await stub.resolveOpaqueRead("/asset", 60_000);

  const replacement = await stub.beginOpaqueUpload("/asset");
  await store.putIfAbsent(replacement.objectKey, "replacement");
  await stub.commitOpaqueUpload(replacement.uploadId);
  await evictDurableObject(stub);

  expect(await stub.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
  const oldBody = await store.getStream(lease.object.key);
  if (oldBody === null) throw new Error("leased opaque generation is missing");
  expect(new TextDecoder().decode(await readAllBytes(oldBody, 16))).toBe("old");
  expect(await stub.stat("/asset")).toMatchObject({
    contentClass: "opaque",
    sizeBytes: 11,
  });
  expect(await env.VFS_TEST_BUCKET.head(replacement.objectKey)).not.toBeNull();
});

it("persists upload-expiry cleanup across eviction and tolerates a duplicate alarm", async () => {
  const stub = workspace("opaque-expiry-alarm");
  const upload = await stub.beginOpaqueUpload("/abandoned", { expiresInMs: 60_000 });
  await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull();
    state.storage.sql.exec(
      "UPDATE vfs_upload_sessions SET expires_at_ms = 0 WHERE id = ?",
      upload.uploadId,
    );
  });
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
  await runInDurableObject(stub, async (_instance, state) => {
    expect(
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_gc_queue").one()
        .count,
    ).toBe(0);
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_gc_queue").one()
        .count,
    ).toBe(0);
  });
});

it("persists failed GC backoff and lets a later alarm finish the retry", async () => {
  const stub = workspace("opaque-gc-alarm-retry");
  const retry = await runInDurableObject(stub, async (_instance, state) => {
    const backing = new MemoryOpaqueStore();
    let failed = false;
    const fileSystem = new DurableObjectFileSystem(state.storage, {
      workspaceId: "alarm-retry",
      opaqueStore: {
        putIfAbsent: (...args) => backing.putIfAbsent(...args),
        head: (...args) => backing.head(...args),
        getStream: (...args) => backing.getStream(...args),
        async delete(...args) {
          if (!failed) {
            failed = true;
            throw new Error("transient R2 delete failure");
          }
          await backing.delete(...args);
        },
      },
    });
    const upload = await fileSystem.beginOpaqueUpload("/asset");
    await backing.putIfAbsent(upload.objectKey, "body");
    await fileSystem.commitOpaqueUpload(upload.uploadId);
    await fileSystem.remove("/asset");
    let message = "";
    try {
      await fileSystem.drainGarbage();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const row = state.storage.sql
      .exec<{
        attempts: number;
        last_error: string;
        next_attempt_at_ms: number;
      }>(
        "SELECT attempts, last_error, next_attempt_at_ms FROM vfs_gc_queue WHERE r2_key = ?",
        upload.objectKey,
      )
      .one();
    state.storage.sql.exec(
      "UPDATE vfs_gc_queue SET next_attempt_at_ms = 0 WHERE r2_key = ?",
      upload.objectKey,
    );
    await state.storage.setAlarm(Date.now() + 60_000);
    return { message, alarm: await state.storage.getAlarm(), ...row };
  });
  expect(retry.message).toContain("transient R2 delete failure");
  expect(retry).toMatchObject({ attempts: 1, last_error: "transient R2 delete failure" });
  expect(retry.next_attempt_at_ms).toBeGreaterThan(0);
  expect(retry.alarm).not.toBeNull();

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_gc_queue").one()
        .count,
    ).toBe(0);
  });
});
