import { VfsError, type VfsErrorCode } from "../core/errors.js";
import { basename, dirname } from "../core/path.js";
import { DEFAULT_VERIFY_LEASE_MS, FILE_MODE } from "./config.js";
import { emitVfsEvent } from "./events.js";
import { type EntryRow, integerColumn, type SqlRow, type UploadRow } from "./sql-model.js";
import { SqlOpaqueStart } from "./sql-opaque-start-base.js";
import type {
  CommitOpaqueUploadOptions,
  OpaqueFileStat,
  OpaqueObjectMetadata,
  OpaqueStore,
} from "./types.js";

interface VerificationLease {
  readonly session: UploadRow;
  readonly token: string;
}

type VerificationStart =
  | { readonly kind: "committed"; readonly stat: OpaqueFileStat }
  | { readonly kind: "expired-receipt"; readonly path: string }
  | { readonly kind: "expired"; readonly session: UploadRow }
  | ({ readonly kind: "verify" } & VerificationLease);

type VerificationProgress =
  | { readonly kind: "committed"; readonly stat: OpaqueFileStat }
  | ({ readonly kind: "verify" } & VerificationLease);

type OpaqueCommit =
  | { readonly kind: "stale"; readonly path: string; readonly objectKey: string }
  | { readonly kind: "committed"; readonly stat: OpaqueFileStat };

interface OpaqueEntryWrite {
  readonly row: SqlRow;
  readonly parentPath: string;
  readonly name: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly createdAtMs: number;
  readonly mutationVersion: number;
}

export abstract class SqlOpaqueCommit extends SqlOpaqueStart {
  async commitOpaqueUpload(
    uploadId: string,
    options: CommitOpaqueUploadOptions = {},
  ): Promise<OpaqueFileStat> {
    const store = this.opaqueStore;
    if (store === undefined) throw new VfsError("ENOTSUP", "opaque storage is not configured");
    const started = this.transaction(() => this.beginOpaqueVerification(uploadId));
    const progress = await this.advanceOpaqueVerification(started);
    if (progress.kind === "committed") return progress.stat;
    const metadata = await this.inspectOpaqueObject(store, uploadId, progress, options);
    const committed = await this.finalizeOpaqueVerification(uploadId, progress, metadata);
    return this.reportOpaqueCommit(uploadId, progress.session.objectKey, committed);
  }

  private beginOpaqueVerification(uploadId: string): VerificationStart {
    const session = this.upload(uploadId);
    if (session === null) throw new VfsError("ENOENT", "upload session does not exist");
    if (session.state === "committed" && session.receiptJson !== null) {
      if (session.expiresAtMs <= this.now()) {
        this.sql.exec("DELETE FROM vfs_upload_sessions WHERE id = ?", uploadId);
        return { kind: "expired-receipt", path: session.path };
      }
      return { kind: "committed", stat: this.parseReceipt(session.receiptJson, session.path) };
    }
    if (session.state === "garbage") {
      throw new VfsError("EREVISION", "upload session can no longer be committed", session.path);
    }
    const now = this.now();
    if (session.expiresAtMs <= now) {
      this.sql.exec("UPDATE vfs_upload_sessions SET state = 'garbage' WHERE id = ?", uploadId);
      this.queueUploadGarbage(session, now);
      return { kind: "expired", session };
    }
    if (session.state === "verifying" && (session.verificationLeaseUntilMs ?? 0) > now) {
      throw new VfsError("EAGAIN", "upload verification is already in progress", session.path);
    }
    const token = this.newToken();
    this.sql.exec(
      `UPDATE vfs_upload_sessions SET
         state = 'verifying', verification_token = ?, verification_lease_until_ms = ?
       WHERE id = ?`,
      token,
      now + DEFAULT_VERIFY_LEASE_MS,
      uploadId,
    );
    return { kind: "verify", session, token };
  }

  private async advanceOpaqueVerification(
    started: VerificationStart,
  ): Promise<VerificationProgress> {
    if (started.kind === "committed") return started;
    await this.scheduleGarbageAlarm();
    if (started.kind === "expired-receipt") {
      throw new VfsError("ENOENT", "committed upload receipt expired", started.path);
    }
    if (started.kind === "expired") {
      throw new VfsError("ETIMEDOUT", "upload session expired", started.session.path);
    }
    return started;
  }

  private async inspectOpaqueObject(
    store: OpaqueStore,
    uploadId: string,
    lease: VerificationLease,
    options: CommitOpaqueUploadOptions,
  ): Promise<OpaqueObjectMetadata> {
    let metadata: OpaqueObjectMetadata | null;
    try {
      metadata = await store.head(lease.session.objectKey);
    } catch (error) {
      this.resetOpaqueVerification(uploadId, lease.token);
      await this.scheduleGarbageAlarm();
      throw error;
    }
    return this.validateOpaqueMetadata(uploadId, lease, metadata, options);
  }

  private async validateOpaqueMetadata(
    uploadId: string,
    lease: VerificationLease,
    metadata: OpaqueObjectMetadata | null,
    options: CommitOpaqueUploadOptions,
  ): Promise<OpaqueObjectMetadata> {
    if (metadata === null) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "object-missing",
        "EIO",
        "uploaded R2 object is missing",
      );
    }
    if (metadata.key !== lease.session.objectKey) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "key-mismatch",
        "EIO",
        "object store returned metadata for the wrong key",
      );
    }
    if (
      lease.session.expectedSizeBytes !== null &&
      metadata.sizeBytes !== lease.session.expectedSizeBytes
    ) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "size-mismatch",
        "EIO",
        "uploaded R2 object size does not match",
      );
    }
    if (
      options.verifiedSha256 !== undefined &&
      options.verifiedSha256 !== metadata.verifiedSha256
    ) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "digest-unverified",
        "EINVAL",
        "SHA-256 was not verified by the trusted object store",
      );
    }
    return metadata;
  }

  private async rejectOpaqueMetadata(
    uploadId: string,
    lease: VerificationLease,
    reason: string,
    code: VfsErrorCode,
    message: string,
  ): Promise<never> {
    const marked = this.markUploadGarbage(
      uploadId,
      lease.session.objectKey,
      lease.token,
      this.now(),
      reason,
    );
    if (!marked) {
      throw new VfsError("EREVISION", "upload verification lease was lost", lease.session.path);
    }
    await this.scheduleGarbageAlarm();
    throw new VfsError(code, message, lease.session.path);
  }

  private resetOpaqueVerification(uploadId: string, token: string): void {
    this.transaction(() => {
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'open', verification_token = NULL, verification_lease_until_ms = NULL
         WHERE id = ? AND state = 'verifying' AND verification_token = ?`,
        uploadId,
        token,
      );
    });
  }

  private async finalizeOpaqueVerification(
    uploadId: string,
    lease: VerificationLease,
    metadata: OpaqueObjectMetadata,
  ): Promise<OpaqueCommit> {
    try {
      const committed = this.transaction(() =>
        this.commitVerifiedOpaqueUpload(uploadId, lease, metadata),
      );
      await this.scheduleGarbageAlarm();
      return committed;
    } catch (error) {
      this.resetOpaqueVerification(uploadId, lease.token);
      await this.scheduleGarbageAlarm();
      throw error;
    }
  }

  private commitVerifiedOpaqueUpload(
    uploadId: string,
    lease: VerificationLease,
    metadata: OpaqueObjectMetadata,
  ): OpaqueCommit {
    const session = this.requireVerificationLease(uploadId, lease);
    if (this.tokenFor(session.path) !== session.expectedMutationToken) {
      return this.staleOpaqueCommit(uploadId, session);
    }
    const existing = this.oneEntry(session.path);
    if (existing?.kind === "directory")
      throw new VfsError("EISDIR", "is a directory", session.path);
    const now = this.now();
    this.prepareParents(session.path, session.createParents, now, []);
    this.assertCapacity(
      existing?.contentClass === "inline" ? -existing.sizeBytes : 0,
      existing === null ? 1 : 0,
      session.path,
    );
    const objectId = this.insertOpaqueObject(session, metadata, now);
    this.removeReplacedInlineBody(existing);
    const written = this.writeOpaqueEntry(session, existing, metadata, objectId, now);
    const stat = this.publishOpaqueEntry(session, existing, metadata, written, now);
    this.storeOpaqueReceipt(uploadId, stat, now);
    return { kind: "committed", stat };
  }

  private requireVerificationLease(uploadId: string, lease: VerificationLease): UploadRow {
    const session = this.upload(uploadId);
    if (
      session === null ||
      session.state !== "verifying" ||
      session.verificationToken !== lease.token
    ) {
      throw new VfsError("EREVISION", "upload verification lease was lost", lease.session.path);
    }
    return session;
  }

  private staleOpaqueCommit(uploadId: string, session: UploadRow): OpaqueCommit {
    this.sql.exec(
      `UPDATE vfs_upload_sessions SET
         state = 'garbage', verification_token = NULL, verification_lease_until_ms = NULL
       WHERE id = ?`,
      uploadId,
    );
    this.queueUploadGarbage(session, this.now());
    return { kind: "stale", path: session.path, objectKey: session.objectKey };
  }

  private insertOpaqueObject(
    session: UploadRow,
    metadata: OpaqueObjectMetadata,
    now: number,
  ): number {
    const row = this.sql
      .exec<SqlRow>(
        `INSERT INTO vfs_opaque_objects (
           r2_key, size_bytes, etag, r2_version, verified_sha256,
           content_type, retain_until_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         RETURNING id`,
        metadata.key,
        metadata.sizeBytes,
        metadata.etag,
        metadata.version,
        metadata.verifiedSha256 ?? null,
        session.contentType ?? metadata.contentType ?? null,
        now,
      )
      .one();
    return integerColumn(row, "id");
  }

  private removeReplacedInlineBody(existing: EntryRow | null): void {
    if (existing?.contentClass !== "inline") return;
    this.sql.exec("DELETE FROM vfs_inline_chunks WHERE entry_id = ?", existing.id);
  }

  private writeOpaqueEntry(
    session: UploadRow,
    existing: EntryRow | null,
    metadata: OpaqueObjectMetadata,
    objectId: number,
    now: number,
  ): OpaqueEntryWrite {
    const parentPath = dirname(session.path);
    const name = basename(session.path);
    const mode = session.mode ?? existing?.mode ?? FILE_MODE;
    const uid = existing?.uid ?? 0;
    const gid = existing?.gid ?? 0;
    const createdAtMs = existing?.createdAtMs ?? now;
    const mutationVersion =
      existing === null ? this.nextEntryVersion(session.path) : existing.mutationVersion + 1;
    const row = this.sql
      .exec<SqlRow>(
        `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           mutation_version
         ) VALUES (?, ?, ?, ?, 'file', 'opaque', ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'opaque', opaque_object_id = excluded.opaque_object_id,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms,
           revision = vfs_entries.revision + 1,
           mutation_version = excluded.mutation_version
         RETURNING id, revision`,
        existing?.id ?? this.allocateIno(),
        session.path,
        parentPath,
        name,
        objectId,
        metadata.sizeBytes,
        mode,
        uid,
        gid,
        createdAtMs,
        now,
        mutationVersion,
      )
      .one();
    return { row, parentPath, name, mode, uid, gid, createdAtMs, mutationVersion };
  }

  private publishOpaqueEntry(
    session: UploadRow,
    existing: EntryRow | null,
    metadata: OpaqueObjectMetadata,
    written: OpaqueEntryWrite,
    now: number,
  ): OpaqueFileStat {
    const token = this.publishToken(
      session.path,
      written.mutationVersion,
      true,
      existing === null ? "create" : "write",
    );
    this.updateUsage(
      existing?.contentClass === "inline" ? -existing.sizeBytes : 0,
      existing === null ? 1 : 0,
    );
    this.queueReplacedOpaqueObject(existing, now);
    const contentType = session.contentType ?? metadata.contentType;
    return {
      path: session.path,
      parentPath: written.parentPath,
      ino: integerColumn(written.row, "id"),
      name: written.name,
      kind: "file",
      contentClass: "opaque",
      sizeBytes: metadata.sizeBytes,
      mode: written.mode,
      uid: written.uid,
      gid: written.gid,
      createdAtMs: written.createdAtMs,
      modifiedAtMs: now,
      revision: integerColumn(written.row, "revision"),
      mutationToken: token,
      ...(contentType === undefined ? {} : { contentType }),
      ...(metadata.verifiedSha256 === undefined ? {} : { verifiedSha256: metadata.verifiedSha256 }),
    };
  }

  private queueReplacedOpaqueObject(existing: EntryRow | null, now: number): void {
    if (existing?.contentClass !== "opaque") return;
    this.queueObjectIfUnreferenced(existing.opaqueObjectId, now);
  }

  private storeOpaqueReceipt(uploadId: string, stat: OpaqueFileStat, now: number): void {
    this.sql.exec(
      `UPDATE vfs_upload_sessions SET
         state = 'committed', verification_token = NULL,
         verification_lease_until_ms = NULL, receipt_json = ?, expires_at_ms = ?
       WHERE id = ?`,
      JSON.stringify(stat),
      now + this.receiptRetentionMs,
      uploadId,
    );
  }

  private reportOpaqueCommit(
    uploadId: string,
    originalObjectKey: string,
    committed: OpaqueCommit,
  ): OpaqueFileStat {
    if (committed.kind === "stale") {
      emitVfsEvent(this.onEvent, {
        type: "vfs.opaque-upload",
        phase: "reject",
        uploadId,
        objectKey: committed.objectKey,
        path: committed.path,
        reason: "stale-path-token",
      });
      throw new VfsError("EREVISION", "path changed after upload reservation", committed.path);
    }
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "commit",
      uploadId,
      objectKey: originalObjectKey,
      path: committed.stat.path,
    });
    return committed.stat;
  }
}
