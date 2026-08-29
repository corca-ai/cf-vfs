import { VfsError } from "../core/errors.js";
import { dirname, normalizePath, pathRequiresDirectory } from "../core/path.js";
import { NEVER_MUTATED_TOKEN } from "./config.js";
import type { VfsMutationOp } from "./events.js";
import { SqlBase } from "./sql-base.js";
import {
  type DirectoryEntryRow,
  type EntryRow,
  firstRow,
  formatMutationToken,
  type InlineEntryRow,
  integerColumn,
  nullableIntegerColumn,
  type PathState,
  type PendingMutation,
  parseEntry,
  type SqlRow,
  type SymlinkEntryRow,
} from "./sql-model.js";
import type { PosixAccessContext } from "./sql-posix.js";
import { ENTRY_COLUMNS } from "./sql-schema.js";
import { MAX_SYMLINK_HOPS } from "./types.js";

export abstract class SqlPath extends SqlBase {
  protected rows(query: string, ...bindings: SqlStorageValue[]): EntryRow[] {
    return this.sql
      .exec<SqlRow>(query, ...bindings)
      .toArray()
      .map((row) => parseEntry(row, this.mutationEpoch));
  }

  protected oneEntry(path: string): EntryRow | null {
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_path
       WHERE e.path = ?`,
        path,
      ),
    );
    return row === undefined ? null : parseEntry(row, this.mutationEpoch);
  }

  /**
   * Reads an entry and its tombstone token as one point lookup.
   *
   * Ordinary reads need only an entry and use `oneEntry`. A streamed write
   * also has to reserve the version of an absent path before it awaits its
   * body, then compare that version inside the commit transaction. A UNION
   * lets one statement answer both questions without making the live
   * row join anything: a removed path returns only its tombstone, and a path
   * never used returns no row at all.
   */
  protected pathState(path: string): PathState {
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs_entries e INDEXED BY vfs_entries_path
         WHERE e.path = ?
         UNION ALL
         SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, NULL, version
         FROM vfs_path_tombstones
         WHERE path = ?
         LIMIT 1`,
        path,
        path,
      ),
    );
    if (row === undefined) return { entry: null, mutationToken: NEVER_MUTATED_TOKEN };
    if (nullableIntegerColumn(row, "id") === null) {
      return {
        entry: null,
        mutationToken: formatMutationToken(
          this.mutationEpoch,
          integerColumn(row, "mutation_version"),
        ),
      };
    }
    const entry = parseEntry(row, this.mutationEpoch);
    return { entry, mutationToken: entry.mutationToken };
  }

  /**
   * The absolute form of a link target, read from the link's own parent.
   *
   * POSIX resolves a relative target against the directory holding the link,
   * not the working directory of whoever is looking, so a tree keeps meaning
   * the same thing wherever it is read from.
   */
  protected linkDestination(row: SymlinkEntryRow): string {
    return row.linkTarget.startsWith("/")
      ? normalizePath(row.linkTarget)
      : normalizePath(row.linkTarget, row.parentPath);
  }

  /**
   * Finds the outermost link on the way to `path`, if there is one.
   *
   * A path that is not in the table either does not exist or lies under a
   * link, and only the second case needs more work. Asking for the ancestors
   * by exact path uses the partial link index and costs one query, rather than
   * one query per component.
   */
  protected linkAncestor(path: string): SymlinkEntryRow | null {
    const ancestors: string[] = [];
    for (let at = dirname(path); at !== "/"; at = dirname(at)) ancestors.push(at);
    if (ancestors.length === 0) return null;
    const row = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e
       WHERE e.kind = 'symlink'
         AND e.path IN (SELECT value FROM json_each(?))
       ORDER BY length(e.path) ASC
       LIMIT 1`,
        JSON.stringify(ancestors),
      ),
    );
    if (row === undefined) return null;
    const entry = parseEntry(row, this.mutationEpoch);
    if (entry.kind !== "symlink") {
      throw new VfsError("EIO", "invalid SQLite entry state", entry.path);
    }
    return entry;
  }

  /**
   * Resolves a pathname, following links in every component.
   *
   * This is the only place a link is ever followed. Everything that reads or
   * writes an entry goes through it, so a policy check, a loop bound, and the
   * rule that a relative target reads from the link's parent cannot be skipped
   * by a caller that has not thought about links.
   *
   * `follow` governs the final component only, which is the difference between
   * `stat` and `lstat`: the components leading up to it are always followed,
   * because a link in the middle of a path is not a thing a caller can act on.
   *
   * When the namespace holds no links at all this is one lookup, the same query
   * the filesystem made before links existed.
   */
  protected resolveEntry(
    input: string,
    follow: boolean,
  ): { path: string; row: EntryRow | null; followed: string[] } {
    let path = input;
    // The links crossed on the way, so a guard can cover the whole chain
    // rather than only where it currently ends.
    const followed: string[] = [];
    for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops += 1) {
      const row = this.oneEntry(path);
      if (row === null) {
        if (this.links() === 0) return { path, row: null, followed };
        const ancestor = this.linkAncestor(path);
        if (ancestor === null) return { path, row: null, followed };
        followed.push(ancestor.path);
        path = normalizePath(
          `${this.linkDestination(ancestor)}/${path.slice(ancestor.path.length)}`,
        );
        continue;
      }
      if (row.kind !== "symlink" || !follow) return { path, row, followed };
      followed.push(row.path);
      path = this.linkDestination(row);
    }
    throw new VfsError("ELOOP", "too many levels of symbolic links", input);
  }

  /**
   * The mutation token for `path`, taken from a row already resolved for it.
   *
   * `oneEntry` reads the live version and `parseEntry` builds the token from
   * that column, so a row in hand carries exactly what `tokenFor` would read.
   * Callers pass a row only when it was fetched at the same point as the
   * decision being made — never across an `await`, where re-reading is the
   * guard rather than a repeat of it.
   */
  protected tokenOf(path: string, entry: EntryRow | null | undefined): string {
    return entry != null && entry.path === path ? entry.mutationToken : this.tokenFor(path);
  }

  /**
   * The token a guard is taken and checked against.
   *
   * A path that crosses a link means whatever the link currently says, so each
   * link's own version is part of what the caller reserved. Without them,
   * repointing a link between the read and the write is invisible whenever the
   * old and new targets happen to share a version — the exact ABA the token
   * exists to catch.
   */
  protected guardToken(path: string, entry?: EntryRow | null): string {
    const normalized = normalizePath(path);
    // With no links the guard is the named path's own token, which is what a
    // row resolved for that same path holds. With links it also covers every
    // one crossed, and those have no row here.
    if (this.links() === 0) return this.tokenOf(normalized, entry);
    const resolved = this.resolveEntry(normalized, true);
    const base = this.tokenFor(resolved.path);
    if (resolved.followed.length === 0) return base;
    return [base, ...resolved.followed.map((link) => this.tokenFor(link))].join("|");
  }

  /**
   * Canonicalizes a path, keeping a final component that does not exist.
   *
   * A caller canonicalizing the destination of a write it has not made yet
   * needs an answer, and refusing would make the policy check below depend on
   * whether the file happened to be there already.
   */
  realpath(path: string, options: { follow?: boolean } = {}, access?: PosixAccessContext): string {
    const normalized = normalizePath(path);
    if (this.links() === 0) {
      this.assertTraverse(normalized, [], access);
      return normalized;
    }
    const resolved = this.resolveEntry(normalized, options.follow !== false);
    this.assertTraverse(resolved.path, resolved.followed, access);
    // Already canonical, present or not: `resolveEntry` substitutes every link
    // ancestor before it gives up, so an absent final component is reported
    // under a path whose parents have all been resolved. Recursing on the
    // parent to "finish the job" would redo that walk once per component, and
    // the hop bound does not apply to depth — a four-thousand-byte path is
    // legal and would cost seconds of uninterruptible CPU.
    return resolved.path;
  }

  protected oneResolved(path: string, follow = true): EntryRow | null {
    return this.resolveEntry(path, follow).row;
  }

  protected requireEntry(path: string, follow = true): EntryRow {
    const row = this.oneResolved(path, follow);
    if (row === null) throw new VfsError("ENOENT", "no such file or directory", path);
    return row;
  }

  protected requireDirectory(path: string, resolved?: EntryRow | null): DirectoryEntryRow {
    // The row resolution already landed on, when the caller has it.
    const row = resolved ?? this.requireEntry(path);
    if (row.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", path);
    return row;
  }

  protected requireInline(path: string, resolved?: EntryRow | null): InlineEntryRow {
    // The row resolution already landed on, when the caller has it: looking it
    // up again would resolve the same path a second time.
    const row = resolved ?? this.requireEntry(path);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (row.contentClass !== "inline") {
      throw new VfsError("ENOTSUP", "opaque R2 content is not available to shell commands", path);
    }
    return row;
  }

  /**
   * Normalizes a path and resolves every link in it to a canonical one.
   *
   * Every operation goes through here, so the paths that reach the table are
   * always canonical: a link can never end up as the parent of an entry, which
   * is what lets an exact-path hit be trusted without walking the components.
   *
   * `followTerminal` is false for the operations that act on a link rather than
   * through it — `rm`, `mv`, `cp`, and `mkdir` name the link itself.
   */
  /**
   * Resolves a path to a canonical one and keeps the entry it landed on.
   *
   * Returning the row rather than only the path is what lets a caller act on a
   * link it asked not to follow. Looking the path up again afterwards would
   * resolve it a second time — with the follow flag lost — and a `rm` of a
   * dangling or cyclic link would fail on the target that is not there.
   *
   * `followTerminal` is false for the operations that name a link rather than
   * reach through it: `rm`, `mv`, `cp -P`, `mkdir`, and `ln -sf`.
   */
  protected resolveAccess(
    path: string,
    allowMissingDirectory = false,
    followTerminal = true,
  ): { path: string; row: EntryRow | null; followed: string[] } {
    // A trailing slash asserts that the path names a directory, so the link is
    // followed even when the caller asked not to follow one: `rm dirlink/` is
    // a question about the directory, not about the link.
    const requiresDirectory = pathRequiresDirectory(path);
    const normalized = normalizePath(path);
    // With no links there is nothing to resolve and no row to fetch, so this
    // costs exactly what it did before links existed: nothing.
    const resolved =
      this.links() === 0
        ? { path: normalized, row: null, followed: [] }
        : this.resolveEntry(normalized, followTerminal || requiresDirectory);
    if (requiresDirectory && resolved.row === null && resolved.path !== "/") {
      resolved.row = this.oneEntry(resolved.path);
    }
    if (!requiresDirectory || resolved.path === "/") return resolved;
    if (resolved.row === null) {
      if (allowMissingDirectory) return resolved;
      throw new VfsError("ENOENT", "no such directory", resolved.path);
    }
    if (resolved.row.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", resolved.path);
    }
    return resolved;
  }

  protected normalizeAccessPath(
    path: string,
    allowMissingDirectory = false,
    followTerminal = true,
  ): string {
    return this.resolveAccess(path, allowMissingDirectory, followTerminal).path;
  }

  protected tokenFor(path: string): string {
    const current = firstRow(
      this.sql.exec<SqlRow>(
        `SELECT mutation_version AS version FROM vfs_entries INDEXED BY vfs_entries_path
         WHERE path = ?
         UNION ALL
         SELECT version FROM vfs_path_tombstones WHERE path = ?
         LIMIT 1`,
        path,
        path,
      ),
    );
    if (current !== undefined) {
      return formatMutationToken(this.mutationEpoch, integerColumn(current, "version"));
    }
    return NEVER_MUTATED_TOKEN;
  }

  /**
   * The sequence to stamp the change being published with.
   *
   * Zero when the cursor is off, which is also the value every row already
   * carries, so the stamped statement is the same statement either way and the
   * feature adds no work to a workspace that has not asked for it.
   *
   * Read from SQLite once per instance and then kept in memory. One number is
   * handed out per publication rather than per row, so every path a set-based
   * mutation touches shares a sequence and a reader sees one change rather
   * than a burst that has to be reassembled.
   */
  protected nextChangeSeq(): number {
    if (!this.recordChanges) return 0;
    if (this.lastChangeSeq === undefined) {
      this.lastChangeSeq = integerColumn(
        this.sql
          .exec<SqlRow>("SELECT COALESCE(MAX(change_seq), 0) AS seq FROM vfs_path_changes")
          .one(),
        "seq",
      );
    }
    this.lastChangeSeq += 1;
    return this.lastChangeSeq;
  }

  protected recordPathChange(path: string, present: boolean, changeSeq?: number): void {
    if (!this.recordChanges) return;
    this.sql.exec(
      `INSERT INTO vfs_path_changes (path, change_seq, present) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         change_seq = excluded.change_seq,
         present = excluded.present`,
      path,
      changeSeq ?? this.nextChangeSeq(),
      present ? 1 : 0,
    );
  }

  /**
   * Publishes a new token for one path and records what changed it.
   *
   * The operation is a parameter rather than something inferred here because
   * this is the single place an ordinary mutation publishes a token, and
   * making it required is what turns "did every mutation report itself" into a
   * question the type checker answers instead of a review does.
   */
  protected publishToken(
    path: string,
    version: number,
    present: boolean,
    op: VfsMutationOp,
  ): string {
    this.recordPathChange(path, present);
    const token = formatMutationToken(this.mutationEpoch, version);
    this.recordMutation({ op, path, mutationToken: token });
    return token;
  }

  /** Consumes an absent path's tombstone and returns its next live version. */
  protected nextEntryVersion(path: string, previousVersion = 0): number {
    const tombstone = firstRow(
      this.sql.exec<SqlRow>(
        "DELETE FROM vfs_path_tombstones WHERE path = ? RETURNING version",
        path,
      ),
    );
    return (
      Math.max(previousVersion, tombstone === undefined ? 0 : integerColumn(tombstone, "version")) +
      1
    );
  }

  /**
   * Holds one change until its transaction commits.
   *
   * Guarded on the sink rather than inside `emitVfsEvent`, so an unobserved
   * workspace does not build an object it would only discard.
   */
  protected recordMutation(mutation: PendingMutation): void {
    if (this.onEvent === undefined) return;
    this.pendingMutations.push(mutation);
  }

  protected validateGuard(
    path: string,
    entry: EntryRow | null,
    guard: { ifMutationToken?: string },
    written?: string,
  ): void {
    if (guard.ifMutationToken === undefined) return;
    // Checked against the path the caller named, not the one it resolved to,
    // so the token covers every link crossed on the way. `getMutationToken`
    // composes it the same way from the same written path.
    const current =
      written === undefined ? this.tokenOf(path, entry) : this.guardToken(written, entry);
    if (current !== guard.ifMutationToken) {
      throw new VfsError("EREVISION", "path mutation token does not match", path);
    }
  }
}
