import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isVfsError, type VfsError } from "../src/core/errors.js";
import { R2OpaqueStore } from "../src/storage/r2.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes, streamFromChunks } from "../src/vfs/streams.js";
import { runVfsConformance, streamThatFailsAfter } from "./helpers/vfs-conformance.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(`byte-${name}`);
}

describe("byte-oriented Durable Object filesystem", () => {
  describe("shared VFS conformance", () => {
    let conformanceId = 0;
    runVfsConformance(() => workspace(`conformance-${conformanceId++}`), {
      negativeMutationRaces: false,
      failedInputStreams: false,
    });
  });

  it("stores arbitrary chunked bytes and returns a stable stream snapshot", async () => {
    const stub = workspace("inline-snapshot");
    const original = new Uint8Array(3000);
    original[0] = 0xff;
    original[2999] = 0x7f;
    await stub.writeFile("/data", original);
    const snapshot = await stub.readFile("/data");
    await stub.writeFile("/data", new Uint8Array([9]));

    expect([...(await readAllBytes(snapshot.stream, 4096))]).toEqual([...original]);
    expect([...(await readAllBytes((await stub.readFile("/data")).stream, 16))]).toEqual([9]);
    await runInDurableObject(stub, (_instance, state) => {
      const chunks = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_inline_chunks")
        .one().count;
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

  it("preserves VfsError discrimination across the RPC boundary", async () => {
    const stub = workspace("rpc-error-shape");

    // Workers RPC rebuilds a thrown error as a plain Error: the own properties
    // survive but the prototype does not. `runInDurableObject` never crosses
    // that boundary, so this must call the stub directly.
    let synchronous: unknown;
    try {
      await stub.stat("/definitely-missing");
    } catch (error) {
      synchronous = error;
    }
    expect(isVfsError(synchronous)).toBe(true);
    expect(synchronous).toMatchObject({
      name: "VfsError",
      code: "ENOENT",
      path: "/definitely-missing",
    });

    await stub.writeFile("/taken", "body");
    let asynchronous: unknown;
    try {
      await stub.writeFile("/taken", "other", { disposition: "create" });
    } catch (error) {
      asynchronous = error;
    }
    expect(isVfsError(asynchronous)).toBe(true);
    expect((asynchronous as VfsError).code).toBe("EEXIST");

    let shellError: unknown;
    try {
      await stub.executeText({ script: "echo hi", cwd: 42 as unknown as string });
    } catch (error) {
      shellError = error;
    }
    expect(isVfsError(shellError)).toBe(true);
    expect((shellError as VfsError).code).toBe("EINVAL");

    expect(isVfsError(new Error("plain"))).toBe(false);
    expect(isVfsError({ name: "VfsError", code: "ENOENT" })).toBe(false);
    expect(
      isVfsError(
        Object.assign(new Error("spoofed"), {
          name: "VfsError",
          code: "ENOTACODE",
        }),
      ),
    ).toBe(false);
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
      const observed = appending.then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.resolve();
      instance.touch("/same");
      finish?.();
      return { copyError, appendError: await observed, stat: instance.stat("/same") };
    });
    expect(result.copyError).toMatchObject({ code: "EINVAL", path: "/same" });
    expect(result.appendError).toMatchObject({ code: "EREVISION", path: "/same" });
    expect(result.stat.sizeBytes).toBe(4);
  });

  it("publishes no partial generation when an input stream fails inside the object", async () => {
    const stub = workspace("failed-stream");
    const result = await runInDurableObject(stub, async (instance) => {
      let createError: unknown;
      try {
        await instance.writeFile("/new", streamThatFailsAfter("partial"));
      } catch (caught) {
        createError = caught;
      }
      const pathsAfterCreate = instance.list("/").map((entry) => entry.path);

      await instance.writeFile("/file", "old");
      let replaceError: unknown;
      try {
        await instance.writeFile("/file", streamThatFailsAfter("partial"));
      } catch (caught) {
        replaceError = caught;
      }
      const body = await readAllBytes(instance.readFile("/file").stream, 16);
      return {
        createError,
        pathsAfterCreate,
        replaceError,
        body: new TextDecoder().decode(body),
      };
    });

    expect(result.createError).toEqual(expect.objectContaining({ message: "source failed" }));
    expect(result.pathsAfterCreate).not.toContain("/new");
    expect(result.replaceError).toEqual(expect.objectContaining({ message: "source failed" }));
    expect(result.body).toBe("old");
  });

  it("enforces schema combinations with CHECK constraints", async () => {
    const stub = workspace("schema-checks");
    await stub.writeFile("/initialize", "x");
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO vfs_entries (
           path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
         ) VALUES ('/bad', '/', 'bad', 'directory', 'inline', NULL,
                   0, 16877, 0, 0, 1, 1, 1)`,
        );
      }),
    ).rejects.toThrow();
  });

  it("skips schema initialization after migration version 1 is present", async () => {
    const stub = workspace("schema-migration-gate");
    await stub.writeFile("/initialized", "x");
    const createdIds = await runInDurableObject(stub, (_instance, state) => {
      let count = 0;
      new DurableObjectFileSystem(state.storage, {
        createId: () => `unexpected-${count++}`,
      });
      return count;
    });
    expect(createdIds).toBe(0);
  });

  it("uses integer entry IDs and epoch-version mutation tokens", async () => {
    const stub = workspace("compact-schema-identities");
    await stub.writeFile("/file", "body");
    const result = await runInDurableObject(stub, (instance, state) => {
      const row = state.storage.sql
        .exec<{
          id: number;
          id_type: string;
          mutation_epoch: string;
          version: number;
        }>(
          `SELECT e.id, typeof(e.id) AS id_type, s.mutation_epoch,
                  e.mutation_version AS version
         FROM vfs_entries e
         JOIN vfs_state s ON s.singleton = 1
         WHERE e.path = '/file'`,
        )
        .one();
      return { row, stat: instance.stat("/file") };
    });

    expect(result.row.id).toBeGreaterThan(0);
    expect(result.row.id_type).toBe("integer");
    expect(result.stat.mutationToken).toBe(`${result.row.mutation_epoch}:${result.row.version}`);
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

  it("rejects a malformed batch before writing any entry", async () => {
    const stub = workspace("batch-rpc-validation");
    const result = await runInDurableObject(stub, async (instance) => {
      let error: unknown;
      try {
        await instance.writeFiles([
          { path: "/valid", body: "body" },
          { path: "/invalid", body: { not: "bytes" } },
        ] as never);
      } catch (caught) {
        error = caught;
      }
      return { error, entries: instance.list("/").length };
    });

    expect(result.error).toMatchObject({
      code: "EINVAL",
      message: "entries[1].body must be bytes, text, or a byte stream",
    });
    expect(result.entries).toBe(0);
  });

  it("rejects POSIX IDs outside the SQLite uint32 range at the RPC boundary", async () => {
    const stub = workspace("shell-rpc-posix-id-range");
    const error = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.executeText({
          script: "echo unreachable",
          credentials: { uid: 0x1_0000_0000, gid: 1 },
        } as never);
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

  it("keeps the SQLite headroom refusal on a same-size replacement", async () => {
    const stub = workspace("database-headroom-same-size");
    await stub.writeFile("/file", "old!");
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        maxDatabaseBytes: state.storage.sql.databaseSize,
        minDatabaseHeadroomBytes: 1,
      });
      try {
        await fileSystem.writeFile("/file", "new!");
        return { error: null, body: "" };
      } catch (caught) {
        const body = new TextDecoder().decode(
          await readAllBytes(fileSystem.readFile("/file").stream, 16),
        );
        return { error: caught, body };
      }
    });
    expect(result.error).toMatchObject({ code: "ENOSPC", path: "/file" });
    expect(result.body).toBe("old!");
  });

  it("rejects chunks that approach the Durable Object SQLite row limit", async () => {
    const stub = workspace("sqlite-chunk-limit");
    const error = await runInDurableObject(stub, (_instance, state) => {
      try {
        new DurableObjectFileSystem(state.storage, {
          chunkBytes: 2 * 1024 * 1024,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    });
    expect(error).toMatchObject({
      code: "EINVAL",
      message: "chunkBytes cannot exceed 1048576 for SQLite storage",
    });
  });

  it("does not create tombstones for absent token reads", async () => {
    const stub = workspace("absent-token-read");
    const result = await runInDurableObject(stub, (instance, state) => {
      const before = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_path_tombstones")
        .one().count;
      const first = instance.getMutationToken("/never-created");
      const second = instance.getMutationToken("/another-absent");
      const after = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_path_tombstones")
        .one().count;
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
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_gc_queue")
          .one().count,
      ).toBe(0);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await env.VFS_TEST_BUCKET.head(upload.objectKey)).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_gc_queue")
          .one().count,
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
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_gc_queue")
          .one().count,
      ).toBe(0);
    });
  });

  it("reports mutations only after the real transaction commits", async () => {
    const stub = workspace("mutation-notification");
    const observed = await runInDurableObject(stub, async (_instance, state) => {
      const events: string[] = [];
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        workspaceId: "mutation-notification",
        maxEntries: 3,
        onEvent: (event) => {
          if (event.type !== "vfs.mutation") return;
          events.push(
            `${event.op} ${event.path}${event.subtree?.to === undefined ? "" : ` -> ${event.subtree.to}`}`,
          );
        },
      });
      await fileSystem.writeFile("/first", "x");
      const committed = [...events];

      // The entry quota refuses this inside the transaction, after the parent
      // directory row has already been written and rolled back with it.
      events.length = 0;
      let refused = "";
      try {
        await fileSystem.writeFile("/parent/child", "x", { createParents: true });
      } catch (error) {
        refused = error instanceof Error ? ((error as { code?: string }).code ?? "") : "";
      }
      const afterRollback = [...events];

      events.length = 0;
      await fileSystem.move("/first", "/second");
      return { committed, refused, afterRollback, moved: [...events] };
    });

    expect(observed.committed).toEqual(["create /first"]);
    expect(observed.refused).toBe("ENOSPC");
    expect(observed.afterRollback).toEqual([]);
    expect(observed.moved).toEqual(["move /first -> /second"]);
  });

  it("never reissues an entry identity after the object is evicted", async () => {
    const stub = workspace("ino-eviction");
    const retired = await runInDurableObject(stub, async (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage, { workspaceId: "ino" });
      await fileSystem.writeFile("/a", "x");
      await fileSystem.writeFile("/b", "x");
      const highest = fileSystem.stat("/b").ino;
      // Removing the newest entry is precisely what a bare rowid recycles.
      await fileSystem.remove("/b");
      return highest;
    });
    expect(retired).toBeGreaterThan(0);

    await evictDurableObject(stub);

    // A revived object holds no counter, so the guarantee rests entirely on
    // `next_ino` having been made durable by the creation that used it. An
    // allocation that skipped `updateUsage` would pass every single-instance
    // test and fail here, handing the retired identity out again.
    const reissued = await runInDurableObject(stub, async (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage, { workspaceId: "ino" });
      await fileSystem.writeFile("/c", "x");
      return fileSystem.stat("/c").ino;
    });
    expect(reissued).toBeGreaterThan(retired);
  });

  it("keeps next_ino ahead of every identity each creation shape issues", async () => {
    const stub = workspace("ino-high-water");
    const observed = await runInDurableObject(stub, async (_instance, state) => {
      const store = new MemoryOpaqueStore();
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        workspaceId: "ino-high-water",
        opaqueStore: store,
      });
      const highWater = (): number =>
        state.storage.sql
          .exec<{ next_ino: number }>("SELECT next_ino FROM vfs_usage WHERE singleton = 1")
          .one().next_ino;
      const highestId = (): number =>
        state.storage.sql
          .exec<{ highest: number }>("SELECT COALESCE(MAX(id), 0) AS highest FROM vfs_entries")
          .one().highest;

      // Every shape that allocates an identity has to make the high-water mark
      // durable in the same transaction. Checking after each one is what
      // catches a new creation path that allocates and forgets.
      const shapes: Array<[string, () => unknown | Promise<unknown>]> = [
        ["mkdir", () => fileSystem.mkdir("/dir/inner", true)],
        ["writeFile", () => fileSystem.writeFile("/dir/inner/file", "x")],
        ["touch", () => fileSystem.touch("/dir/touched", { create: true })],
        ["symlink", () => fileSystem.symlink("/dir/link", "inner/file")],
        ["copy", () => fileSystem.copy("/dir", "/copied", { recursive: true })],
        [
          "opaque commit",
          async () => {
            const upload = await fileSystem.beginOpaqueUpload("/blob");
            await store.putIfAbsent(upload.objectKey, "body");
            await fileSystem.commitOpaqueUpload(upload.uploadId);
          },
        ],
      ];
      const behind: string[] = [];
      for (const [name, run] of shapes) {
        await run();
        if (highWater() <= highestId()) behind.push(name);
      }
      return { behind, highWater: highWater(), highestId: highestId() };
    });

    expect(observed.behind).toEqual([]);
    expect(observed.highWater).toBeGreaterThan(observed.highestId);
  });

  it("resumes the change sequence after the object is evicted", async () => {
    const stub = workspace("change-cursor-eviction");
    const before = await runInDurableObject(stub, async (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        workspaceId: "change-cursor",
        recordChanges: true,
      });
      await fileSystem.writeFile("/a", "one");
      return fileSystem.changesSince(0).cursor;
    });
    expect(before).toBeGreaterThan(0);

    await evictDurableObject(stub);

    // A revived object holds no counter, so it has to read the highest
    // sequence back out of SQLite. Restarting from zero would hand a caller
    // sequences it has already seen and silently drop the changes between.
    const after = await runInDurableObject(stub, async (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage, {
        workspaceId: "change-cursor",
        recordChanges: true,
      });
      await fileSystem.writeFile("/b", "two");
      return fileSystem.changesSince(before);
    });
    expect(after.changes).toEqual([{ path: "/b", present: true }]);
    expect(after.cursor).toBeGreaterThan(before);
  });

  describe("sharing the alarm with a composing host", () => {
    /** Reads the maintenance time the filesystem would want to be woken at. */
    async function uploadExpiry(
      stub: DurableObjectStub<TestWorkspaceVfs>,
      uploadId: string,
    ): Promise<number> {
      return runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{
              expires_at_ms: number;
            }>("SELECT expires_at_ms FROM vfs_upload_sessions WHERE id = ?", uploadId)
            .one().expires_at_ms,
      );
    }

    it("leaves an earlier host alarm in place when maintenance is due later", async () => {
      const stub = workspace("alarm-host-earlier");
      const hostAlarm = Date.now() + 60_000;
      await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(hostAlarm));

      // Due an hour out, so the filesystem would previously have overwritten
      // the host's alarm with its own later time and stopped the host's timer.
      await stub.beginOpaqueUpload("/late", { expiresInMs: 3_600_000 });

      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
        hostAlarm,
      );
    });

    it("arms its own earlier time without waiting for a later host alarm", async () => {
      const stub = workspace("alarm-maintenance-earlier");
      const hostAlarm = Date.now() + 3_600_000;
      await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(hostAlarm));

      const upload = await stub.beginOpaqueUpload("/soon", { expiresInMs: 60_000 });
      const due = await uploadExpiry(stub, upload.uploadId);

      expect(due).toBeLessThan(hostAlarm);
      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
        due,
      );
    });

    it("does not delete a host alarm when no maintenance is due", async () => {
      const stub = workspace("alarm-nothing-due");
      const hostAlarm = Date.now() + 60_000;
      await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(hostAlarm));

      // Nothing is queued, so this reschedules with a null due time — the path
      // that used to clear whatever alarm happened to be set.
      await expect(stub.drainGarbage()).resolves.toMatchObject({ deleted: 0, remaining: 0 });

      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
        hostAlarm,
      );
    });

    it("re-arms maintenance after the host's earlier alarm fires", async () => {
      const stub = workspace("alarm-rearm-after-host");
      const upload = await stub.beginOpaqueUpload("/later", { expiresInMs: 3_600_000 });
      const due = await uploadExpiry(stub, upload.uploadId);
      const hostAlarm = Date.now() + 60_000;
      await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(hostAlarm));
      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
        hostAlarm,
      );

      // The host's alarm fires first and its handler runs maintenance, which is
      // what re-arms the filesystem's own later time. Deferring to the host is
      // only safe because every exit from drainGarbage() reschedules.
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
        due,
      );
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
      const failed = state.storage.sql
        .exec<{
          attempts: number;
          last_error: string;
        }>("SELECT attempts, last_error FROM vfs_gc_queue WHERE r2_key = ?", upload.objectKey)
        .one();
      const objectExistsAfterFailure = backing.has(upload.objectKey);
      state.storage.sql.exec(
        "UPDATE vfs_gc_queue SET next_attempt_at_ms = 0 WHERE r2_key = ?",
        upload.objectKey,
      );
      const retried = await fileSystem.drainGarbage();
      const queued = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM vfs_gc_queue WHERE r2_key = ?",
          upload.objectKey,
        )
        .one().count;
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
      const started = new Promise<void>((resolve) => {
        headStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseHead = resolve;
      });
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
      const observed = committing.then(
        () => null,
        (error: unknown) => error,
      );
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
      const garbage = state.storage.sql
        .exec<{ state: string; queued: number }>(
          `SELECT state,
                (SELECT COUNT(*) FROM vfs_gc_queue WHERE r2_key = s.r2_key) AS queued
         FROM vfs_upload_sessions s WHERE id = ?`,
          upload.uploadId,
        )
        .one();
      state.storage.sql.exec(
        `UPDATE vfs_gc_queue SET not_before_ms = 0, next_attempt_at_ms = 0
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
      const firstStarted = new Promise<void>((resolve) => {
        firstHeadStarted = resolve;
      });
      const secondStarted = new Promise<void>((resolve) => {
        secondHeadStarted = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
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
      const firstObserved = first.then(
        () => null,
        (error: unknown) => error,
      );
      await firstStarted;
      now = 61_000;
      const second = fileSystem.commitOpaqueUpload(upload.uploadId);
      await secondStarted;
      releaseFirst?.();
      const firstError = await firstObserved;
      const verifying = state.storage.sql
        .exec<{ state: string; queued: number }>(
          `SELECT state,
                (SELECT COUNT(*) FROM vfs_gc_queue WHERE r2_key = s.r2_key) AS queued
         FROM vfs_upload_sessions s WHERE id = ?`,
          upload.uploadId,
        )
        .one();
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

  it("carries numeric credentials, groups, and umask across shell RPC", async () => {
    const stub = workspace("shell-posix-identity-rpc");
    await stub.mkdir("/home");
    await stub.setOwnership("/home", { uid: 1_000, gid: 10 });
    await stub.setMetadata("/home", { mode: 0o040700 });
    const result = await stub.executeText({
      script: "id; printf body > /home/file; chown :20 /home/file; stat -c '%u:%g:%a' /home/file",
      credentials: { uid: 1_000, gid: 10, supplementaryGids: [20] },
      umask: 0o027,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "uid=1000 gid=10 groups=10,20\n1000:20:640\n",
      stderr: "",
    });
  });

  it("checks credentials on paths deeper than the SQL binding limit", async () => {
    const stub = workspace("deep-posix-path");
    const path = `/${Array.from({ length: 120 }, (_unused, index) => `d${index}`).join("/")}`;
    const stat = await runInDurableObject(stub, (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage);
      fileSystem.mkdir(path, true);
      return fileSystem.forCredentials({ uid: 0, gid: 0 }).stat(path);
    });
    expect(stat.path).toBe(path);
  });

  it("resolves symlinks on paths deeper than the SQL binding limit", async () => {
    const stub = workspace("deep-symlink-path");
    const suffix = `/${Array.from({ length: 120 }, (_unused, index) => `d${index}`).join("/")}`;
    const stat = await runInDurableObject(stub, (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage);
      fileSystem.mkdir(`/target${suffix}`, true);
      fileSystem.symlink("/link", "/target");
      return fileSystem.stat(`/link${suffix}`);
    });
    expect(stat.path).toBe(`/target${suffix}`);
  });

  it("preflights recursive permissions with more than 100 groups", async () => {
    const stub = workspace("many-posix-groups");
    const removed = await runInDurableObject(stub, async (_instance, state) => {
      const fileSystem = new DurableObjectFileSystem(state.storage);
      fileSystem.mkdir("/home/tree", true);
      fileSystem.setOwnership("/home", { uid: 1_000, gid: 10 });
      fileSystem.setMetadata("/home", { mode: 0o040700 });
      fileSystem.setOwnership("/home/tree", { uid: 1_000, gid: 10 });
      fileSystem.setMetadata("/home/tree", { mode: 0o040700 });
      await fileSystem.writeFile("/home/tree/file", "body");
      const user = fileSystem.forCredentials({
        uid: 1_000,
        gid: 10,
        supplementaryGids: Array.from({ length: 120 }, (_unused, index) => 100 + index),
      });
      return user.remove("/home/tree", { recursive: true });
    });
    expect(removed).toEqual({ removed: 2, opaqueObjectsQueuedForDeletion: 0 });
  });

  it("preserves an interactive session over the SQLite-backed VFS", async () => {
    const stub = workspace("interactive-shell-rpc");
    await expect(
      stub.executeInteractiveText("mkdir -p /repo; cd /repo; NAME=sqlite; printf body > file"),
    ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
    await expect(
      stub.executeInteractiveText('printf \'%s:%s:\' "$PWD" "$NAME"; cat file'),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "/repo:sqlite:body",
      stderr: "",
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });
  });

  it("does not create or reject a missing touch -c target through RPC", async () => {
    const stub = workspace("shell-touch-no-create-rpc");
    const result = await stub.executeText({
      script: "touch /existing; touch -c /missing /existing; [[ ! -e /missing && -e /existing ]]",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
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
        'shift "$((OPTIND - 1))"',
        'printf \'%s:%s|%s:%s\' "$FIRST" "$SECOND" "$OPTARG" "$1"',
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
        'printf \'%s|%s|%s\' "${STEM//t/T}" "${VALUE:4:10}" "${VALUE: -2}"',
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

  it("propagates deterministic errexit contexts through the Durable Object shell", async () => {
    const stub = workspace("shell-errexit-v4-rpc");
    const result = await stub.executeText({
      script: [
        "cat > /failure.sh <<'EOF'",
        "false",
        "printf sourced",
        "EOF",
        "set -e",
        "run() { false; printf function; }",
        "run || printf fallback",
        "source /failure.sh || printf fallback",
        "(false; printf sub) || printf fallback",
        "VALUE=$(false; printf value)",
        "printf '|%s|' \"$VALUE\"",
        "set -o pipefail",
        "false | true",
        "touch /after",
      ].join("\n"),
    });
    expect(result).toEqual({
      exitCode: 1,
      stdout: "functionsourcedsub|value|",
      stderr: "",
    });
    await expect(stub.executeText({ script: "[[ ! -e /after ]]" })).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      stub.executeText({
        script: "set -e; fail() { return 7; }; fail; printf no",
      }),
    ).resolves.toEqual({ exitCode: 7, stdout: "", stderr: "" });
  });

  it("exposes opaque files to double-bracket metadata predicates without reading R2", async () => {
    const stub = workspace("shell-double-bracket-opaque-v3");
    const upload = await stub.beginOpaqueUpload("/asset", { expectedSizeBytes: 4 });
    await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
    await stub.commitOpaqueUpload(upload.uploadId);
    const result = await stub.executeText({
      script: "[[ -e /asset && -f /asset && ! -d /asset ]] && printf opaque",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "opaque", stderr: "" });
    expect((await stub.stat("/asset")).contentClass).toBe("opaque");
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
