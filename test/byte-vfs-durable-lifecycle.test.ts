import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(`byte-${name}`);
}

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
