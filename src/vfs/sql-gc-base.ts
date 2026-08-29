import { VfsError } from "../core/errors.js";
import { DEFAULT_READ_LEASE_MS, MAX_READ_LEASE_MS, validatePositiveInteger } from "./config.js";
import { emitVfsEvent } from "./events.js";
import {
  integerColumn,
  metadataFromObject,
  rowToStat,
  type SqlRow,
  stringColumn,
} from "./sql-model.js";
import { SqlOpaqueCommit } from "./sql-opaque-commit-base.js";
import type { GarbageDrainResult, OpaqueReadLease } from "./types.js";

const MAX_GC_BATCH = 100;

interface GarbageBatch {
  readonly expiredSessions: Array<{ uploadId: string; objectKey: string; path: string }>;
  readonly keys: string[];
}

export abstract class SqlGc extends SqlOpaqueCommit {
  async abortOpaqueUpload(uploadId: string): Promise<void> {
    let aborted: { path: string; objectKey: string } | undefined;
    this.transaction(() => {
      const session = this.upload(uploadId);
      if (session === null || session.state === "garbage" || session.state === "committed") return;
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ?`,
        uploadId,
      );
      this.queueUploadGarbage(session, this.now());
      aborted = { path: session.path, objectKey: session.objectKey };
    });
    if (aborted === undefined) return;
    await this.scheduleGarbageAlarm();
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "abort",
      uploadId,
      objectKey: aborted.objectKey,
      path: aborted.path,
    });
  }

  resolveOpaqueRead(path: string, leaseMs = DEFAULT_READ_LEASE_MS): OpaqueReadLease {
    validatePositiveInteger(leaseMs, "leaseMs");
    const normalized = this.normalizeAccessPath(path);
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      if (entry.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
      if (entry.contentClass !== "opaque") {
        throw new VfsError("ENOTSUP", "file is not opaque", normalized);
      }
      const object = this.opaqueObject(entry.opaqueObjectId);
      if (object === null)
        throw new VfsError("EIO", "opaque object metadata is missing", normalized);
      const leaseExpiresAtMs = this.now() + Math.min(leaseMs, MAX_READ_LEASE_MS);
      this.sql.exec(
        `UPDATE vfs_opaque_objects
         SET retain_until_ms = MAX(retain_until_ms, ?) WHERE id = ?`,
        leaseExpiresAtMs,
        object.id,
      );
      return {
        stat: rowToStat(entry),
        object: metadataFromObject(object),
        leaseExpiresAtMs,
      };
    });
  }

  async drainGarbage(limit = MAX_GC_BATCH): Promise<GarbageDrainResult> {
    validatePositiveInteger(limit, "limit");
    const store = this.opaqueStore;
    const batchLimit = Math.min(limit, MAX_GC_BATCH);
    const now = this.now();
    const { expiredSessions, keys } = this.selectGarbageBatch(now, batchLimit);
    for (const session of expiredSessions) {
      emitVfsEvent(this.onEvent, { type: "vfs.opaque-upload", phase: "expire", ...session });
    }
    if (store === undefined || keys.length === 0) {
      await this.scheduleGarbageAlarm();
      const remaining = this.garbageDepth();
      emitVfsEvent(this.onEvent, {
        type: "vfs.garbage",
        deleted: 0,
        remaining,
        failed: 0,
      });
      return { deleted: 0, remaining };
    }
    const selectedKeys = JSON.stringify(keys);
    try {
      await store.delete(keys);
      this.transaction(() => {
        this.sql.exec(
          "DELETE FROM vfs_upload_sessions WHERE state='garbage' AND r2_key IN(SELECT value FROM json_each(?))",
          selectedKeys,
        );
        this.sql.exec(
          "DELETE FROM vfs_gc_queue WHERE r2_key IN (SELECT value FROM json_each(?))",
          selectedKeys,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transaction(() => {
        this.sql.exec(
          "UPDATE vfs_gc_queue SET attempts=attempts+1,next_attempt_at_ms=?+MIN((1<<MIN(attempts+1,12))*1000,60*60*1000),last_error=? WHERE r2_key IN(SELECT value FROM json_each(?))",
          now,
          message,
          selectedKeys,
        );
      });
      await this.scheduleGarbageAlarm();
      emitVfsEvent(this.onEvent, {
        type: "vfs.garbage",
        deleted: 0,
        remaining: this.garbageDepth(),
        failed: keys.length,
      });
      throw error;
    }
    await this.scheduleGarbageAlarm();
    const remaining = this.garbageDepth();
    emitVfsEvent(this.onEvent, {
      type: "vfs.garbage",
      deleted: keys.length,
      remaining,
      failed: 0,
    });
    return { deleted: keys.length, remaining };
  }

  private selectGarbageBatch(now: number, batchLimit: number): GarbageBatch {
    const expiredSessions: GarbageBatch["expiredSessions"] = [];
    const keys = this.transaction(() => {
      const expired = this.sql
        .exec<SqlRow>(
          "SELECT id,path,r2_key,expires_at_ms FROM vfs_upload_sessions WHERE(state='open' AND expires_at_ms<=?)OR(state='verifying' AND verification_lease_until_ms<=?)LIMIT ?",
          now,
          now,
          batchLimit,
        )
        .toArray();
      for (const row of expired) {
        const id = stringColumn(row, "id");
        this.sql.exec(
          "UPDATE vfs_upload_sessions SET state='garbage',verification_token=NULL,verification_lease_until_ms=NULL WHERE id=?",
          id,
        );
        const objectKey = stringColumn(row, "r2_key");
        this.queueGarbage(
          objectKey,
          Math.max(now, integerColumn(row, "expires_at_ms") + this.uploadSettlementGraceMs),
        );
        expiredSessions.push({
          uploadId: id,
          objectKey,
          path: stringColumn(row, "path"),
        });
      }
      this.sql.exec(
        "DELETE FROM vfs_upload_sessions WHERE state = 'committed' AND expires_at_ms <= ?",
        now,
      );
      return this.sql
        .exec<SqlRow>(
          "SELECT r2_key FROM vfs_gc_queue WHERE not_before_ms<=? AND next_attempt_at_ms<=? ORDER BY next_attempt_at_ms,not_before_ms LIMIT ?",
          now,
          now,
          batchLimit,
        )
        .toArray()
        .map((row) => stringColumn(row, "r2_key"));
    });
    return { expiredSessions, keys };
  }

  protected garbageDepth(): number {
    return integerColumn(
      this.sql.exec<SqlRow>("SELECT COUNT(*) AS value FROM vfs_gc_queue").one(),
      "value",
    );
  }
}
