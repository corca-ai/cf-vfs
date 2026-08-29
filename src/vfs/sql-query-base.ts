import { VfsError } from "../core/errors.js";
import { globToRegExp } from "../core/glob.js";
import {
  depthFrom,
  descendantRange,
  dirname,
  normalizePath,
  pathRequiresDirectory,
} from "../core/path.js";
import { validatePositiveInteger } from "./config.js";
import { SqlContent } from "./sql-content-base.js";
import {
  type EntryRow,
  type FindScanContext,
  firstRow,
  integerColumn,
  type OpaqueObjectRow,
  parseEntry,
  rowToStat,
  type SqlRow,
  stringColumn,
} from "./sql-model.js";
import {
  EXECUTE_PERMISSION,
  type PosixAccessContext,
  type PosixMutationOperation,
  READ_PERMISSION,
  WRITE_PERMISSION,
} from "./sql-posix.js";
import { ENTRY_COLUMNS } from "./sql-schema.js";
import type {
  ChangePage,
  ChangesSinceOptions,
  EntryPage,
  FindOptions,
  MutationTokenOptions,
  PageOptions,
  SubtreeSummary,
  VfsStat,
} from "./types.js";

const DEFAULT_CHANGE_PAGE = 1000;
const MAX_CHANGE_PAGE = 10_000;

export abstract class SqlQuery extends SqlContent {
  protected abstract opaqueObject(id: number): OpaqueObjectRow | null;

  stat(path: string, access?: PosixAccessContext): VfsStat {
    return this.statEntry(path, true, access);
  }

  /** Reports a link as itself rather than as what it points at. */
  lstat(path: string, access?: PosixAccessContext): VfsStat {
    return this.statEntry(path, false, access);
  }

  /**
   * Reports the entry holding an identity. See {@link VirtualFileSystem.statById}.
   *
   * One statement and one row: `id` is `INTEGER PRIMARY KEY`, which SQLite
   * makes an alias for the rowid, so this seeks the table's own key and needs
   * no index of its own.
   *
   * Takes no access context. The credential-bound view refuses the call rather
   * than filtering it, because an identity carries no path to check ancestors
   * of and because answering by one at all is what a dense counter makes
   * enumerable.
   */
  statById(ino: number): VfsStat {
    if (!Number.isSafeInteger(ino) || ino < 1) {
      throw new VfsError("EINVAL", "entry identity must be a positive safe integer");
    }
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e
       WHERE e.id = ?`,
        ino,
      ),
    );
    if (row === undefined) throw new VfsError("ENOENT", "no entry holds that identity");
    return rowToStat(parseEntry(row, this.mutationEpoch));
  }

  readlink(path: string, access?: PosixAccessContext): string {
    const resolved = this.accessEntry(path, false);
    this.assertTraverse(resolved.path, resolved.followed, access);
    const row = resolved.row;
    if (row === null) throw new VfsError("ENOENT", "no such file or directory", resolved.path);
    if (row.kind !== "symlink") {
      throw new VfsError("EINVAL", "not a symbolic link", row.path);
    }
    return row.linkTarget;
  }

  /**
   * Resolves a path once and keeps the row it landed on.
   *
   * Normalizing and then looking up would resolve the same path twice, which
   * would double what every read costs as soon as a single link exists
   * anywhere in the namespace.
   */
  protected accessEntry(
    path: string,
    follow: boolean,
  ): { path: string; row: EntryRow | null; followed: string[] } {
    const requiresDirectory = pathRequiresDirectory(path);
    const resolved = this.resolveEntry(normalizePath(path), follow || requiresDirectory);
    if (requiresDirectory && resolved.row !== null && resolved.row.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", resolved.path);
    }
    return resolved;
  }

  protected statEntry(path: string, follow: boolean, posix?: PosixAccessContext): VfsStat {
    const access = this.accessEntry(path, follow);
    this.assertTraverse(access.path, access.followed, posix);
    if (access.row === null) {
      throw new VfsError("ENOENT", "no such file or directory", access.path);
    }
    const row = access.row;
    const stat = rowToStat(row);
    if (row.contentClass !== "opaque") {
      return stat;
    }
    const object = this.opaqueObject(row.opaqueObjectId);
    if (object === null) throw new VfsError("EIO", "opaque object metadata is missing", row.path);
    return {
      ...stat,
      ...(object.contentType === null ? {} : { contentType: object.contentType }),
      ...(object.verifiedSha256 === null ? {} : { verifiedSha256: object.verifiedSha256 }),
    };
  }

  getMutationToken(
    path: string,
    options: MutationTokenOptions = {},
    access?: PosixAccessContext,
  ): string {
    // Resolved by default, so the token belongs to the row the matching write
    // would guard. Reading it from the written path would return the link's
    // version and never match the target's.
    if (access === undefined) {
      return this.transaction(() =>
        options.follow === false
          ? this.tokenFor(this.normalizeAccessPath(path, true, false))
          : this.guardToken(path),
      );
    }
    return this.transaction(() => {
      const resolved = this.resolveAccess(path, true, options.follow !== false);
      this.assertTraverse(resolved.path, resolved.followed, access);
      return options.follow === false ? this.tokenFor(resolved.path) : this.guardToken(path);
    });
  }

  list(path: string, posix?: PosixAccessContext): VfsStat[] {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const directory = this.requireDirectory(normalized, access.row);
    this.assertPermission(directory, posix, READ_PERMISSION | EXECUTE_PERMISSION, normalized);
    return this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_parent_name
       WHERE e.parent_path = ? AND e.path <> '/'
       ORDER BY e.name`,
      normalized,
    ).map(rowToStat);
  }

  listPage(path: string, options: PageOptions = {}, posix?: PosixAccessContext): EntryPage {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const directory = this.requireDirectory(normalized, access.row);
    this.assertPermission(directory, posix, READ_PERMISSION | EXECUTE_PERMISSION, normalized);
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    const cursor = options.cursor ?? "";
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const cursorName = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
    const indexedCursorName = cursorName.includes("/") ? "" : cursorName;
    const rows = this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_parent_name
       WHERE e.parent_path = ? AND e.name > ? AND e.path <> '/' AND e.path > ?
       ORDER BY e.name LIMIT ?`,
      normalized,
      indexedCursorName,
      cursor,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map(rowToStat),
      nextCursor: rows.length > limit ? (page.at(-1)?.path ?? null) : null,
      scanned: page.length,
    };
  }

  find(options: FindOptions, access?: PosixAccessContext): VfsStat[] {
    const maximum = options.limit ?? 10_000;
    validatePositiveInteger(maximum, "limit");
    const result: VfsStat[] = [];
    let cursor = options.cursor;
    const context = this.findScanContext(options, access);
    do {
      const page = this.scanFindPage(context, {
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(maximum - result.length, 1000),
      });
      result.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && result.length < maximum);
    return result;
  }

  findPage(options: FindOptions, posix?: PosixAccessContext): EntryPage {
    const limit = options.limit ?? 1000;
    validatePositiveInteger(limit, "limit");
    return this.scanFindPage(this.findScanContext(options, posix), options);
  }

  protected findScanContext(options: FindOptions, posix?: PosixAccessContext): FindScanContext {
    const access = this.resolveAccess(options.path);
    const root = access.path;
    const rootEntry = access.row ?? this.requireEntry(root);
    if (posix !== undefined) {
      this.assertTraverse(root, access.followed, posix);
      this.assertPermission(
        rootEntry,
        posix,
        rootEntry.kind === "directory" ? READ_PERMISSION | EXECUTE_PERMISSION : 0,
        root,
      );
      if (rootEntry.kind === "directory") {
        this.assertSubtreePermissions(root, posix, 0, READ_PERMISSION | EXECUTE_PERMISSION);
      }
    }
    return {
      root,
      rootEntry,
      range: descendantRange(root),
      namePattern: options.name === undefined ? undefined : globToRegExp(options.name),
      pathPattern: options.pathGlob === undefined ? undefined : globToRegExp(options.pathGlob),
    };
  }

  protected scanFindPage(context: FindScanContext, options: FindOptions): EntryPage {
    const { root, rootEntry, range, namePattern, pathPattern } = context;
    const limit = options.limit ?? 1000;
    const cursor = options.cursor ?? (root === "/" ? "" : root);
    const includeRoot =
      options.cursor === undefined && (rootEntry.kind === "file" || (options.includeRoot ?? false));
    const descendants =
      rootEntry.kind === "file"
        ? []
        : this.rows(
            `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_path
       WHERE e.path >= ? AND e.path < ? AND e.path > ? AND e.path <> ?
       ORDER BY e.path LIMIT ?`,
            range.lower,
            range.upper,
            cursor,
            root,
            limit + (includeRoot ? 0 : 1),
          );
    const scannedRows = (includeRoot ? [rootEntry, ...descendants] : descendants).slice(0, limit);
    const entries = scannedRows
      .filter((row) => {
        if (options.maxDepth !== undefined && depthFrom(root, row.path) > options.maxDepth)
          return false;
        if (options.type !== undefined && row.kind !== options.type) return false;
        if (namePattern !== undefined && !namePattern.test(row.name)) return false;
        if (pathPattern !== undefined && !pathPattern.test(row.path)) return false;
        return true;
      })
      .map(rowToStat);
    const hasMore = descendants.length + (includeRoot ? 1 : 0) > limit;
    return {
      entries,
      nextCursor: hasMore ? (scannedRows.at(-1)?.path ?? null) : null,
      scanned: scannedRows.length,
    };
  }

  subtreeSummary(path: string, posix?: PosixAccessContext): SubtreeSummary {
    // A link names one zero-byte entry and has no subtree. Not following it
    // also means a dangling link can be summarized like any other entry.
    const access = this.resolveAccess(path, false, false);
    this.assertTraverse(access.path, access.followed, posix);
    const entry = access.row ?? this.requireEntry(access.path, false);
    if (entry.kind === "symlink") return { entries: 1, inlineBytes: 0, logicalFileBytes: 0 };
    this.assertSubtreePermissions(access.path, posix, 0, READ_PERMISSION | EXECUTE_PERMISSION);
    return this.aggregateSubtree(access.path);
  }

  /**
   * Internal shell-budget preflight with the permission semantics of the
   * mutation it is charging. In particular, rename does not need read access
   * to a source subtree merely because its entry count is used as a limit.
   */
  countPosixMutationSubtree(
    path: string,
    operation: PosixMutationOperation,
    posix?: PosixAccessContext,
  ): number {
    const access = this.resolveAccess(
      path,
      false,
      operation.kind === "copy" && operation.dereference,
    );
    const entry = access.row ?? this.requireEntry(access.path, false);
    this.assertTraverse(access.path, access.followed, posix);
    if (operation.kind === "copy") {
      if (entry.kind === "file") {
        this.assertPermission(entry, posix, READ_PERMISSION, access.path);
      } else if (entry.kind === "directory") {
        this.assertSubtreePermissions(
          access.path,
          posix,
          READ_PERMISSION,
          READ_PERMISSION | EXECUTE_PERMISSION,
        );
      }
    } else {
      const parent = this.requireDirectory(dirname(access.path));
      this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, access.path);
      this.assertStickyRemoval(parent, entry, posix, access.path);
      if (operation.kind === "remove-recursive" && entry.kind === "directory") {
        this.assertSubtreePermissions(access.path, posix, 0, WRITE_PERMISSION | EXECUTE_PERMISSION);
        this.assertSubtreeSticky(access.path, posix);
      }
    }
    return entry.kind === "symlink" ? 1 : this.aggregateSubtree(access.path).entries;
  }

  changesSince(since: number, options: ChangesSinceOptions = {}): ChangePage {
    if (!this.recordChanges) {
      throw new VfsError("ENOTSUP", "the change cursor is not enabled for this filesystem");
    }
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new VfsError("EINVAL", "since must be a non-negative safe integer");
    }
    const limit = options.limit ?? DEFAULT_CHANGE_PAGE;
    validatePositiveInteger(limit, "limit");
    const bounded = Math.min(limit, MAX_CHANGE_PAGE);
    // The cursor names a sequence, not a path within one. A set-based mutation
    // gives every path the same sequence, so cutting that group at `bounded`
    // would make the next `change_seq > cursor` page skip its remainder. The
    // scalar cutoff finds the sequence at the requested boundary and the main
    // scan includes that whole sequence. A single atomic change may therefore
    // make a page larger than requested, but no path can be lost between pages.
    const rows = this.sql
      .exec<SqlRow>(
        `WITH cutoff AS (
           SELECT (
             SELECT change_seq
             FROM vfs_path_changes
             WHERE change_seq > ?
             ORDER BY change_seq, path
             LIMIT 1 OFFSET ?
           ) AS seq
         )
       SELECT v.path AS path, v.present AS present, v.change_seq AS seq,
              EXISTS (
                SELECT 1 FROM vfs_path_changes remaining
                WHERE cutoff.seq IS NOT NULL AND remaining.change_seq > cutoff.seq
              ) AS more
       FROM vfs_path_changes v
       CROSS JOIN cutoff
       WHERE v.change_seq > ? AND (cutoff.seq IS NULL OR v.change_seq <= cutoff.seq)
       ORDER BY v.change_seq, v.path`,
        since,
        bounded - 1,
        since,
      )
      .toArray();
    const changes = rows.map((row) => ({
      path: stringColumn(row, "path"),
      present: integerColumn(row, "present") === 1,
    }));
    const last = rows.at(-1);
    return {
      changes,
      cursor: last === undefined ? since : integerColumn(last, "seq"),
      more: last === undefined ? false : integerColumn(last, "more") === 1,
    };
  }
}
