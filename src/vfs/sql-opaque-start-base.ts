import { VfsError } from "../core/errors.js";
import { DEFAULT_UPLOAD_TTL_MS, validatePositiveInteger } from "./config.js";
import { emitVfsEvent } from "./events.js";
import { SqlCopy } from "./sql-copy-base.js";
import { parseOpaqueReceipt } from "./sql-model.js";
import type { BeginOpaqueUploadOptions, OpaqueFileStat, OpaqueUploadReservation } from "./types.js";

export abstract class SqlOpaqueStart extends SqlCopy {
  async beginOpaqueUpload(
    path: string,
    options: BeginOpaqueUploadOptions = {},
  ): Promise<OpaqueUploadReservation> {
    if (this.opaqueStore === undefined) {
      throw new VfsError("ENOTSUP", "opaque storage is not configured");
    }
    const access = this.resolveAccess(path);
    const normalized = access.path;
    const traversal = access.followed.length !== 0;
    const existing = this.oneEntry(normalized);
    if (existing?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (
      options.expectedSizeBytes !== undefined &&
      (!Number.isSafeInteger(options.expectedSizeBytes) || options.expectedSizeBytes < 0)
    ) {
      throw new VfsError("EINVAL", "expectedSizeBytes must be a non-negative safe integer");
    }
    const expiresInMs = options.expiresInMs ?? DEFAULT_UPLOAD_TTL_MS;
    validatePositiveInteger(expiresInMs, "expiresInMs");
    const reservation = this.transaction(() => {
      this.assertCapacity(0, 0, normalized);
      const token = this.tokenFor(normalized);
      const writtenToken = traversal ? this.guardToken(path) : token;
      if (options.ifMutationToken !== undefined && options.ifMutationToken !== writtenToken) {
        throw new VfsError("EREVISION", "path mutation token does not match", normalized);
      }
      const uploadId = this.createId();
      const objectKey = `vfs/${this.workspaceId}/objects/${this.createId()}`;
      const expiresAtMs = this.now() + expiresInMs;
      this.sql.exec(
        `INSERT INTO vfs_upload_sessions (
           id, path, expected_mutation_token, r2_key, state,
           verification_token, expected_size_bytes, expires_at_ms,
           verification_lease_until_ms, create_parents, mode,
           content_type, receipt_json, written_path, traversal_token
         ) VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
        uploadId,
        normalized,
        token,
        objectKey,
        options.expectedSizeBytes ?? null,
        expiresAtMs,
        options.createParents === true ? 1 : 0,
        options.mode ?? null,
        options.contentType ?? null,
        ...this.traversalColumns(traversal, path, writtenToken),
      );
      return {
        uploadId,
        path: normalized,
        objectKey,
        expectedMutationToken: token,
        expiresAtMs,
        ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      };
    });
    await this.scheduleGarbageAlarm();
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "begin",
      uploadId: reservation.uploadId,
      objectKey: reservation.objectKey,
      path: reservation.path,
    });
    return reservation;
  }

  private traversalColumns(
    traversal: boolean,
    path: string,
    token: string,
  ): [string | null, string | null] {
    return traversal ? [path, token] : [null, null];
  }
  protected parseReceipt(value: string, path: string): OpaqueFileStat {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new VfsError("EIO", "invalid committed upload receipt", path);
    }
    return parseOpaqueReceipt(parsed, path);
  }

  protected markUploadGarbage(
    uploadId: string,
    objectKey: string,
    verificationToken: string,
    now: number,
    reason?: string,
  ): boolean {
    const rejected = this.transaction(() => {
      const session = this.upload(uploadId);
      if (
        session === null ||
        session.state !== "verifying" ||
        session.objectKey !== objectKey ||
        session.verificationToken !== verificationToken
      )
        return false;
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ? AND state = 'verifying' AND verification_token = ?`,
        uploadId,
        verificationToken,
      );
      this.queueUploadGarbage(session, now);
      return { path: session.path };
    });
    if (rejected === false) return false;
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "reject",
      uploadId,
      objectKey,
      path: rejected.path,
      ...(reason === undefined ? {} : { reason }),
    });
    return true;
  }
}
