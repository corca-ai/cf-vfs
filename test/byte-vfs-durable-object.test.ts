import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { R2OpaqueStore } from "../src/storage/r2.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes, streamFromChunks } from "../src/vfs/streams.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { runVfsConformance } from "./helpers/vfs-conformance.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(`byte-${name}`);
}

describe("byte-oriented Durable Object filesystem", () => {
  describe("shared VFS conformance", () => {
    let conformanceId = 0;
    runVfsConformance(
      () => workspace(`conformance-${conformanceId++}`) as unknown as VirtualFileSystem,
      { negativeMutationRaces: false },
    );
  });

  it("stores arbitrary chunked bytes and returns a stable stream snapshot", async () => {
    const stub = workspace("inline-snapshot");
    const original = new Uint8Array(3000);
    original[0] = 0xff;
    original[2999] = 0x7f;
    await stub.writeFile("/data", original);
    const snapshot = await stub.readFile("/data");
    await stub.writeFile("/data", new Uint8Array([9]));

    expect([...await readAllBytes(snapshot.stream, 4096)]).toEqual([...original]);
    expect([...await readAllBytes((await stub.readFile("/data")).stream, 16)]).toEqual([9]);
    await runInDurableObject(stub, (_instance, state) => {
      const chunks = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_inline_chunks",
      ).one().count;
      expect(chunks).toBe(1);
    });
  });

  it("returns RPC byte streams that support BYOB readers", async () => {
    const stub = workspace("rpc-byob");
    await stub.writeFile("/bytes", Uint8Array.of(1, 2, 3));
    const reader = (await stub.readFile("/bytes")).stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(3));
    expect(first.done).toBe(false);
    expect([...(first.value ?? new Uint8Array())]).toEqual([1, 2, 3]);
    await reader.cancel();
  });

  it("rejects self-copy and a stale empty append atomically inside the object", async () => {
    const stub = workspace("mutation-races");
    const result = await runInDurableObject(stub, async (instance) => {
      await instance.writeFile("/same", "body");
      let copyError: unknown;
      try {
        await instance.copy("/same", "/same", { replace: true });
      } catch (error) {
        copyError = error;
      }

      let finish: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          finish = () => controller.close();
        },
      });
      const appending = instance.appendFile("/same", body);
      const observed = appending.then(() => null, (error: unknown) => error);
      await Promise.resolve();
      instance.touch("/same");
      finish?.();
      return { copyError, appendError: await observed, stat: instance.stat("/same") };
    });
    expect(result.copyError).toMatchObject({ code: "EINVAL", path: "/same" });
    expect(result.appendError).toMatchObject({ code: "EREVISION", path: "/same" });
    expect(result.stat.sizeBytes).toBe(4);
  });

  it("enforces schema combinations with CHECK constraints", async () => {
    const stub = workspace("schema-checks");
    await stub.writeFile("/initialize", "x");
    await expect(runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO vfs2_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, created_at_ms, modified_at_ms, revision
         ) VALUES ('bad', '/bad', '/', 'bad', 'directory', 'inline', NULL,
                   0, 16877, 1, 1, 1)`,
      );
    })).rejects.toThrow();
  });

  it("rejects malformed RPC booleans before destructive operations", async () => {
    const stub = workspace("rpc-validation");
    const result = await runInDurableObject(stub, async (instance) => {
      instance.mkdir("/dir");
      await instance.writeFile("/dir/file", "body");
      let error: unknown;
      try {
        await instance.remove("/dir", { recursive: "false" } as never);
      } catch (caught) {
        error = caught;
      }
      return { error, stat: instance.stat("/dir/file") };
    });
    expect(result.error).toMatchObject({ code: "EINVAL" });
    expect(result.stat.path).toBe("/dir/file");
  });

  it("rejects malformed shell RPC DTOs deterministically", async () => {
    const stub = workspace("shell-rpc-validation");
    const error = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.executeText({ script: 123 } as never);
        return null;
      } catch (caught) {
        return caught;
      }
    });
    expect(error).toMatchObject({ code: "EINVAL" });
  });

  it("fails writes before the configured SQLite headroom is consumed", async () => {
    const stub = workspace("database-headroom");
    await stub.writeFile("/initialize", "x");
    const error = await runInDurableObject(stub, async (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        maxDatabaseBytes: state.storage.sql.databaseSize,
        minDatabaseHeadroomBytes: 1,
      });
      try {
        await fileSystem.writeFile("/blocked", "body");
        return null;
      } catch (caught) {
        return caught;
      }
    });
    expect(error).toMatchObject({ code: "ENOSPC", path: "/blocked" });
    const statError = await runInDurableObject(stub, (instance) => {
      try {
        return instance.stat("/blocked");
      } catch (caught) {
        return caught;
      }
    });
    expect(statError).toMatchObject({ code: "ENOENT", path: "/blocked" });
  });

  it("does not create persistent path-version rows for absent token reads", async () => {
    const stub = workspace("absent-token-read");
    const result = await runInDurableObject(stub, (instance, state) => {
      const before = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_path_versions",
      ).one().count;
      const first = instance.getMutationToken("/never-created");
      const second = instance.getMutationToken("/another-absent");
      const after = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_path_versions",
      ).one().count;
      return { before, after, first, second };
    });
    expect(result.after).toBe(result.before);
    expect(result.first).toBe(result.second);
  });

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
      const afterFailure = state.storage.sql.exec<{
        state: string;
        verification_token: string | null;
        verification_lease_until_ms: number | null;
        queued: number;
      }>(
        `SELECT state, verification_token, verification_lease_until_ms,
                (SELECT COUNT(*) FROM vfs2_gc_queue WHERE r2_key = s.r2_key) AS queued
         FROM vfs2_upload_sessions s WHERE id = ?`,
        upload.uploadId,
      ).one();
      const committed = await fileSystem.commitOpaqueUpload(upload.uploadId);
      return { message, afterFailure, committed };
    });
    expect(result.message).toBe("transient R2 head failure");
    expect(result.afterFailure).toEqual({
      state: "open",
      verification_token: null,
      verification_lease_until_ms: null,
      queued: 0,
    });
    expect(result.committed).toMatchObject({ path: "/asset", contentClass: "opaque" });
  });

  it("validates committed receipts and expires them without removing the file", async () => {
    const stub = workspace("receipt-retention");
    const upload = await stub.beginOpaqueUpload("/asset");
    await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
    await stub.commitOpaqueUpload(upload.uploadId);
    const error = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE vfs2_upload_sessions SET receipt_json = ? WHERE id = ?",
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
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE vfs2_upload_sessions SET expires_at_ms = 0, receipt_json = ? WHERE id = ?",
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
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_upload_sessions WHERE id = ?",
        upload.uploadId,
      ).one().count).toBe(0);
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
        "UPDATE vfs2_gc_queue SET not_before_ms = 0, next_attempt_at_ms = 0 WHERE r2_key = ?",
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
        "UPDATE vfs2_gc_queue SET not_before_ms = 0, next_attempt_at_ms = 0 WHERE r2_key = ?",
        upload.objectKey,
      );
    });
    await stub.drainGarbage();
    expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
  });

  it("defers deletion for a bounded opaque read lease", async () => {
    const stub = workspace("opaque-read-lease");
    const upload = await stub.beginOpaqueUpload("/asset");
    await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
    await stub.commitOpaqueUpload(upload.uploadId);
    const lease = await stub.resolveOpaqueRead("/asset", 60_000);

    await stub.remove("/asset");
    expect(await stub.drainGarbage()).toEqual({ deleted: 0, remaining: 1 });
    expect(await env.VFS_TEST_BUCKET.head(lease.object.key)).not.toBeNull();
  });

  it("persists upload-expiry cleanup across eviction and tolerates a duplicate alarm", async () => {
    const stub = workspace("opaque-expiry-alarm");
    const upload = await stub.beginOpaqueUpload("/abandoned", { expiresInMs: 60_000 });
    await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      state.storage.sql.exec(
        "UPDATE vfs2_upload_sessions SET expires_at_ms = 0 WHERE id = ?",
        upload.uploadId,
      );
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_gc_queue",
      ).one().count).toBe(0);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_gc_queue",
      ).one().count).toBe(0);
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
      const row = state.storage.sql.exec<{
        attempts: number;
        last_error: string;
        next_attempt_at_ms: number;
      }>(
        "SELECT attempts, last_error, next_attempt_at_ms FROM vfs2_gc_queue WHERE r2_key = ?",
        upload.objectKey,
      ).one();
      state.storage.sql.exec(
        "UPDATE vfs2_gc_queue SET next_attempt_at_ms = 0 WHERE r2_key = ?",
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
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_gc_queue",
      ).one().count).toBe(0);
    });
  });

  it("retries GC when R2 deletes the object but its success response is lost", async () => {
    const stub = workspace("opaque-gc-lost-response");
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const backing = new MemoryOpaqueStore();
      let loseDeleteResponse = true;
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        workspaceId: "gc-lost-response",
        opaqueStore: {
          putIfAbsent: (...args) => backing.putIfAbsent(...args),
          head: (...args) => backing.head(...args),
          getStream: (...args) => backing.getStream(...args),
          async delete(...args) {
            await backing.delete(...args);
            if (loseDeleteResponse) {
              loseDeleteResponse = false;
              throw new Error("R2 delete response lost");
            }
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
      const failed = state.storage.sql.exec<{
        attempts: number;
        last_error: string;
      }>(
        "SELECT attempts, last_error FROM vfs2_gc_queue WHERE r2_key = ?",
        upload.objectKey,
      ).one();
      const objectExistsAfterFailure = backing.has(upload.objectKey);
      state.storage.sql.exec(
        "UPDATE vfs2_gc_queue SET next_attempt_at_ms = 0 WHERE r2_key = ?",
        upload.objectKey,
      );
      const retried = await fileSystem.drainGarbage();
      const queued = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs2_gc_queue WHERE r2_key = ?",
        upload.objectKey,
      ).one().count;
      return { message, failed, objectExistsAfterFailure, retried, queued };
    });
    expect(result).toMatchObject({
      message: "R2 delete response lost",
      failed: { attempts: 1, last_error: "R2 delete response lost" },
      objectExistsAfterFailure: false,
      retried: { deleted: 1, remaining: 0 },
      queued: 0,
    });
  });

  it("lets abort win against an in-flight verifier without publishing the path", async () => {
    const stub = workspace("opaque-abort-verifier-race");
    const result = await runInDurableObject(stub, async (_instance, state) => {
      let headStarted: (() => void) | undefined;
      let releaseHead: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { headStarted = resolve; });
      const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
      const backing = new MemoryOpaqueStore();
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        workspaceId: "abort-verifier-race",
        opaqueStore: {
          putIfAbsent: (...args) => backing.putIfAbsent(...args),
          async head(key) {
            headStarted?.();
            await gate;
            return backing.head(key);
          },
          getStream: (...args) => backing.getStream(...args),
          delete: (...args) => backing.delete(...args),
        },
        uploadSettlementGraceMs: 1,
      });
      const upload = await fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 60_000 });
      await backing.putIfAbsent(upload.objectKey, "body");
      const committing = fileSystem.commitOpaqueUpload(upload.uploadId);
      const observed = committing.then(() => null, (error: unknown) => error);
      await started;
      await fileSystem.abortOpaqueUpload(upload.uploadId);
      releaseHead?.();
      const commitError = await observed;
      let statError: unknown;
      try {
        fileSystem.stat("/asset");
      } catch (error) {
        statError = error;
      }
      const garbage = state.storage.sql.exec<{ state: string; queued: number }>(
        `SELECT state,
                (SELECT COUNT(*) FROM vfs2_gc_queue WHERE r2_key = s.r2_key) AS queued
         FROM vfs2_upload_sessions s WHERE id = ?`,
        upload.uploadId,
      ).one();
      state.storage.sql.exec(
        `UPDATE vfs2_gc_queue SET not_before_ms = 0, next_attempt_at_ms = 0
         WHERE r2_key = ?`,
        upload.objectKey,
      );
      const drained = await fileSystem.drainGarbage();
      return {
        commitError,
        statError,
        garbage,
        drained,
        objectExistsAfterDrain: backing.has(upload.objectKey),
      };
    });
    expect(result.commitError).toMatchObject({ code: "EREVISION", path: "/asset" });
    expect(result.statError).toMatchObject({ code: "ENOENT", path: "/asset" });
    expect(result.garbage).toEqual({ state: "garbage", queued: 1 });
    expect(result.drained).toEqual({ deleted: 1, remaining: 0 });
    expect(result.objectExistsAfterDrain).toBe(false);
  });

  it("prevents an expired verifier from garbage-collecting a newer verifier", async () => {
    const stub = workspace("verifier-cas");
    const result = await runInDurableObject(stub, async (_instance, state) => {
      let now = 0;
      let firstHeadStarted: (() => void) | undefined;
      let secondHeadStarted: (() => void) | undefined;
      let releaseFirst: (() => void) | undefined;
      let releaseSecond: (() => void) | undefined;
      const firstStarted = new Promise<void>((resolve) => { firstHeadStarted = resolve; });
      const secondStarted = new Promise<void>((resolve) => { secondHeadStarted = resolve; });
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const backing = new MemoryOpaqueStore();
      let heads = 0;
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        opaqueStore: {
          putIfAbsent: (...args) => backing.putIfAbsent(...args),
          async head(key) {
            heads += 1;
            if (heads === 1) {
              firstHeadStarted?.();
              await firstGate;
              return null;
            }
            secondHeadStarted?.();
            await secondGate;
            return backing.head(key);
          },
          getStream: (...args) => backing.getStream(...args),
          delete: (...args) => backing.delete(...args),
        },
        now: () => now,
        uploadSettlementGraceMs: 1,
      });
      const upload = await fileSystem.beginOpaqueUpload("/asset", { expiresInMs: 120_000 });
      await backing.putIfAbsent(upload.objectKey, "body");
      const first = fileSystem.commitOpaqueUpload(upload.uploadId);
      const firstObserved = first.then(() => null, (error: unknown) => error);
      await firstStarted;
      now = 61_000;
      const second = fileSystem.commitOpaqueUpload(upload.uploadId);
      await secondStarted;
      releaseFirst?.();
      const firstError = await firstObserved;
      const verifying = state.storage.sql.exec<{ state: string; queued: number }>(
        `SELECT state,
                (SELECT COUNT(*) FROM vfs2_gc_queue WHERE r2_key = s.r2_key) AS queued
         FROM vfs2_upload_sessions s WHERE id = ?`,
        upload.uploadId,
      ).one();
      releaseSecond?.();
      const committed = await second;
      return { firstError, verifying, committed };
    });
    expect(result.firstError).toMatchObject({ code: "EREVISION" });
    expect(result.verifying).toEqual({ state: "verifying", queued: 0 });
    expect(result.committed).toMatchObject({ path: "/asset", contentClass: "opaque" });
  });

  it("executes Bash-compatible source over bounded RPC text results", async () => {
    const stub = workspace("shell-text-rpc");
    const result = await stub.executeText({
      script: "mkdir -p /repo; printf world > /repo/name; printf 'hello '; cat /repo/name",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "hello world", stderr: "" });
  });

  it("sources an inline VFS unit through the Durable Object shell", async () => {
    const stub = workspace("shell-source-rpc");
    const result = await stub.executeText({
      script: [
        "cat > /library.sh <<'EOF'",
        "VALUE=sourced",
        "show() { printf '%s' \"$VALUE\"; }",
        "return 7",
        "EOF",
        "source /library.sh argument || printf '%s|' \"$?\"",
        "show",
      ].join("\n"),
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "7|sourced", stderr: "" });
  });

  it("reads streamed records and parses positional options through RPC", async () => {
    const stub = workspace("shell-input-builtins-rpc");
    const result = await stub.executeText({
      script: [
        "read -r FIRST",
        "read -r SECOND",
        "getopts 'a:' OPT",
        "shift \"$((OPTIND - 1))\"",
        "printf '%s:%s|%s:%s' \"$FIRST\" \"$SECOND\" \"$OPTARG\" \"$1\"",
      ].join("\n"),
      args: ["-a", "value", "tail"],
      stdin: streamFromChunks([
        new TextEncoder().encode("first\nsec"),
        new TextEncoder().encode("ond\n"),
      ]),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "first:second|value:tail",
      stderr: "",
    });
  });

  it("expands bounded parameter patterns and substrings through RPC", async () => {
    const stub = workspace("shell-parameter-v3-rpc");
    const result = await stub.executeText({
      script: [
        "VALUE=src/components/button.ts",
        "BASE=${VALUE##*/}",
        "STEM=${BASE%.ts}",
        "printf '%s|%s|%s' \"${STEM//t/T}\" \"${VALUE:4:10}\" \"${VALUE: -2}\"",
      ].join("\n"),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "buTTon|components|ts",
      stderr: "",
    });
  });

  it("contains nounset termination at an isolated RPC shell scope", async () => {
    const stub = workspace("shell-nounset-v3-rpc");
    const result = await stub.executeText({
      script: [
        "set -u",
        "(printf '%s' \"$MISSING\") || printf '%s|' \"$?\"",
        "set +u",
        "printf '<%s>' \"$MISSING\"",
      ].join("\n"),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "1|<>",
      stderr: "MISSING: unbound variable\n",
    });
  });

  it("uses caller-provided byte streams for the remote streaming boundary", async () => {
    const stub = workspace("shell-stream-rpc");
    const input = streamFromChunks([new TextEncoder().encode("streamed")]);
    const stdout = new IdentityTransformStream();
    const stderr = new IdentityTransformStream();

    const call = stub.executeTo({
      script: "cat",
      stdin: input,
      stdout: stdout.writable,
      stderr: stderr.writable,
    });
    const [status, output, error] = await Promise.all([
      call,
      new Response(stdout.readable).text(),
      new Response(stderr.readable).text(),
    ]);
    expect(status.exitCode).toBe(0);
    expect(output).toBe("streamed");
    expect(error).toBe("");
  });
});
