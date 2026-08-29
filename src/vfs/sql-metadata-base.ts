import { VfsError } from "../core/errors.js";
import { basename, dirname } from "../core/path.js";
import { utf8ByteLength } from "../core/unicode.js";
import { DIRECTORY_MODE, FILE_MODE, SYMLINK_MODE } from "./config.js";
import { type EntryRow, integerColumn, rowToStat, type SqlRow } from "./sql-model.js";
import {
  EXECUTE_PERMISSION,
  type PosixAccessContext,
  posixId,
  WRITE_PERMISSION,
} from "./sql-posix.js";
import { SqlWrite } from "./sql-write-base.js";
import type {
  MetadataUpdateOptions,
  OwnershipUpdateOptions,
  SymlinkOptions,
  TouchOptions,
  VfsStat,
} from "./types.js";
import { MAX_SYMLINK_TARGET_BYTES } from "./types.js";

export abstract class SqlMetadata extends SqlWrite {
  setMetadata(
    path: string,
    options: MetadataUpdateOptions,
    posix?: PosixAccessContext,
    writtenFollowed: readonly string[] = [],
  ): VfsStat {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    const followed =
      writtenFollowed.length === 0 ? access.followed : [...writtenFollowed, ...access.followed];
    this.assertTraverse(normalized, followed, posix);
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      this.assertTraverse(normalized, followed, posix);
      if (options.mode !== undefined) this.assertOwner(entry, posix, normalized);
      else if (posix !== undefined && posix.credentials.uid !== entry.uid) {
        this.assertPermission(entry, posix, WRITE_PERMISSION, normalized);
      }
      this.validateGuard(normalized, entry, options);
      const mutationVersion = entry.mutationVersion + 1;
      const modifiedAtMs = options.modifiedAtMs ?? this.now();
      this.sql.exec(
        `UPDATE vfs_entries SET mode = ?, modified_at_ms = ?, revision = revision + 1,
           mutation_version = ?
         WHERE id = ?`,
        options.mode ?? entry.mode,
        modifiedAtMs,
        mutationVersion,
        entry.id,
      );
      const token = this.publishToken(normalized, mutationVersion, true, "metadata");
      return rowToStat({
        ...entry,
        mode: options.mode ?? entry.mode,
        modifiedAtMs,
        revision: entry.revision + 1,
        mutationVersion,
        mutationToken: token,
      });
    });
  }

  setOwnership(path: string, options: OwnershipUpdateOptions, posix?: PosixAccessContext): VfsStat {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    if (options.uid === undefined && options.gid === undefined) {
      throw new VfsError("EINVAL", "setOwnership requires uid or gid", normalized);
    }
    const uid = options.uid === undefined ? undefined : posixId(options.uid, "options.uid");
    const gid = options.gid === undefined ? undefined : posixId(options.gid, "options.gid");
    return this.transaction(() =>
      this.commitOwnership(normalized, access.followed, options, uid, gid, posix),
    );
  }

  private commitOwnership(
    path: string,
    followed: readonly string[],
    options: OwnershipUpdateOptions,
    uid: number | undefined,
    gid: number | undefined,
    posix: PosixAccessContext | undefined,
  ): VfsStat {
    const entry = this.requireEntry(path);
    this.assertTraverse(path, followed, posix);
    if (posix !== undefined && posix.credentials.uid !== 0) {
      if (uid !== undefined && uid !== entry.uid) {
        throw new VfsError("EPERM", "only root may change a file owner", path);
      }
      this.assertOwner(entry, posix, path);
      if (gid !== undefined && !posix.groups.has(gid)) {
        throw new VfsError("EPERM", "group is not in the current user's groups", path);
      }
    }
    this.validateGuard(path, entry, options);
    const mutationVersion = entry.mutationVersion + 1;
    const modifiedAtMs = this.now();
    const mode =
      posix !== undefined && posix.credentials.uid !== 0 && (uid !== undefined || gid !== undefined)
        ? entry.mode & ~0o6000
        : entry.mode;
    this.sql.exec(
      `UPDATE vfs_entries
       SET uid = ?, gid = ?, mode = ?, modified_at_ms = ?, revision = revision + 1,
           mutation_version = ? WHERE id = ?`,
      uid ?? entry.uid,
      gid ?? entry.gid,
      mode,
      modifiedAtMs,
      mutationVersion,
      entry.id,
    );
    const token = this.publishToken(path, mutationVersion, true, "metadata");
    return rowToStat({
      ...entry,
      uid: uid ?? entry.uid,
      gid: gid ?? entry.gid,
      mode,
      modifiedAtMs,
      revision: entry.revision + 1,
      mutationVersion,
      mutationToken: token,
    });
  }

  touch(path: string, options: TouchOptions = {}, posix?: PosixAccessContext): VfsStat {
    const access = this.resolveAccess(path, true);
    const normalized = access.path;
    const existing = access.row ?? this.oneEntry(normalized);
    if (existing !== null) {
      // `setMetadata` receives the canonical target below, so retain the
      // written side of any followed link here. Both sides need search
      // permission; otherwise `touch hidden/link` could reach an accessible
      // target through a directory the caller cannot traverse.
      return this.setMetadata(normalized, options, posix, access.followed);
    }
    if (options.create === false) {
      throw new VfsError("ENOENT", "no such file or directory", normalized);
    }
    return this.transaction(() =>
      this.createTouchedFile(normalized, access.followed, options, posix),
    );
  }

  private createTouchedFile(
    path: string,
    followed: readonly string[],
    options: TouchOptions,
    posix: PosixAccessContext | undefined,
  ): VfsStat {
    const parents =
      posix === undefined ? undefined : this.creationParents(path, options.createParents ?? false);
    if (parents !== undefined) this.assertCreationAccess(path, followed, posix, parents.existing);
    this.validateGuard(path, null, options);
    const now = this.now();
    const parent =
      parents === undefined
        ? this.prepareParents(path, options.createParents ?? false, now, followed, posix)
        : this.createMissingParents(path, now, posix, parents);
    const owner = posix === undefined ? { uid: 0, gid: 0 } : this.creationOwner(parent, posix);
    const mode =
      posix === undefined
        ? (options.mode ?? FILE_MODE)
        : this.creationMode(options.mode ?? FILE_MODE, posix, parent, false);
    this.assertCapacity(0, 1, path);
    const mutationVersion = this.nextEntryVersion(path);
    const inserted = this.sql
      .exec<SqlRow>(
        `INSERT INTO vfs_entries (
         id, path, parent_path, name, kind, content_class, opaque_object_id,
         size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
         mutation_version
       ) VALUES (?, ?, ?, ?, 'file', 'inline', NULL, 0, ?, ?, ?, ?, ?, 1, ?)
       RETURNING id`,
        this.allocateIno(),
        path,
        dirname(path),
        basename(path),
        mode,
        owner.uid,
        owner.gid,
        now,
        options.modifiedAtMs ?? now,
        mutationVersion,
      )
      .one();
    const token = this.publishToken(path, mutationVersion, true, "create");
    this.updateUsage(0, 1);
    return {
      path,
      parentPath: dirname(path),
      name: basename(path),
      ino: integerColumn(inserted, "id"),
      kind: "file",
      contentClass: "inline",
      sizeBytes: 0,
      mode,
      uid: owner.uid,
      gid: owner.gid,
      createdAtMs: now,
      modifiedAtMs: options.modifiedAtMs ?? now,
      revision: 1,
      mutationToken: token,
    };
  }

  mkdir(
    path: string,
    recursive = false,
    mode = DIRECTORY_MODE,
    posix?: PosixAccessContext,
  ): VfsStat {
    // An existing link at the path is an existing entry, so `mkdir` reports
    // EEXIST rather than creating a directory at whatever it points at.
    const access = this.resolveAccess(path, true, false);
    const normalized = access.path;
    return this.transaction(() => {
      const existing = access.row ?? this.oneEntry(normalized);
      if (existing !== null) {
        this.assertTraverse(normalized, access.followed, posix);
        if (recursive && existing.kind === "directory") {
          this.assertPermission(existing, posix, EXECUTE_PERMISSION, normalized);
          return rowToStat(existing);
        }
        throw new VfsError("EEXIST", "file or directory already exists", normalized);
      }
      const now = this.now();
      const parent = this.prepareParents(normalized, recursive, now, access.followed, posix);
      this.assertCapacity(0, 1, normalized);
      return rowToStat(this.createDirectory(normalized, now, mode, posix, false, parent));
    });
  }

  symlink(
    path: string,
    target: string,
    options: SymlinkOptions = {},
    posix?: PosixAccessContext,
  ): VfsStat {
    const access = this.resolveAccess(path, true, false);
    const normalized = access.path;
    const parentPath = dirname(normalized);
    const name = basename(normalized);
    if (normalized === "/") throw new VfsError("EEXIST", "file or directory exists", normalized);
    if (target.length === 0) throw new VfsError("EINVAL", "link target is empty", normalized);
    const bytes = utf8ByteLength(target);
    if (bytes > MAX_SYMLINK_TARGET_BYTES) {
      throw new VfsError("ENAMETOOLONG", "link target is too long", normalized);
    }
    return this.transaction(() =>
      this.commitSymlink(
        normalized,
        parentPath,
        name,
        target,
        bytes,
        options,
        posix,
        access.followed,
        access.row,
      ),
    );
  }

  private commitSymlink(
    path: string,
    parentPath: string,
    name: string,
    target: string,
    bytes: number,
    options: SymlinkOptions,
    posix: PosixAccessContext | undefined,
    followed: readonly string[],
    resolved: EntryRow | null,
  ): VfsStat {
    const existing = resolved ?? this.oneEntry(path);
    if (existing !== null) {
      if (!(options.replace ?? false)) {
        throw new VfsError("EEXIST", "file or directory exists", path);
      }
      if (existing.kind === "directory") {
        throw new VfsError("EISDIR", "is a directory", path);
      }
    }
    this.validateGuard(path, existing, {
      ...(options.ifMutationToken === undefined
        ? {}
        : { ifMutationToken: options.ifMutationToken }),
    });
    const now = this.now();
    const parent = this.prepareParents(path, options.createParents ?? false, now, followed, posix);
    if (existing !== null && posix !== undefined) {
      this.assertStickyRemoval(parent, existing, posix, path);
    }
    if (existing !== null) this.removeExact(path, now, false);
    const owner = posix === undefined ? { uid: 0, gid: 0 } : this.creationOwner(parent, posix);
    // A path's revision never goes backwards. What lands on an occupied path
    // takes one past whatever was there, so a holder of the old number
    // cannot see it come round again. Only the root of what arrives can land
    // on an occupied path -- a non-empty directory cannot be replaced, so
    // every descendant lands somewhere that was absent.
    const revision = (existing?.revision ?? 0) + 1;
    const mutationVersion = this.nextEntryVersion(path, existing?.mutationVersion);
    this.assertCapacity(0, 1, path);
    const inserted = this.sql
      .exec<SqlRow>(
        `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           mutation_version
        ) VALUES (?, ?, ?, ?, 'symlink', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        this.allocateIno(),
        path,
        parentPath,
        name,
        target,
        bytes,
        SYMLINK_MODE,
        owner.uid,
        owner.gid,
        now,
        now,
        revision,
        mutationVersion,
      )
      .one();
    this.updateUsage(0, 1);
    const token = this.publishToken(
      path,
      mutationVersion,
      true,
      existing === null ? "create" : "write",
    );
    this.symlinkCount += 1;
    return rowToStat({
      id: integerColumn(inserted, "id"),
      path: path,
      parentPath,
      name,
      kind: "symlink",
      contentClass: null,
      opaqueObjectId: null,
      linkTarget: target,
      sizeBytes: bytes,
      mode: SYMLINK_MODE,
      uid: owner.uid,
      gid: owner.gid,
      createdAtMs: now,
      modifiedAtMs: now,
      revision,
      mutationVersion,
      mutationToken: token,
    });
  }
}
