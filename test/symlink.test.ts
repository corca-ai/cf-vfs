import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlFileSystem, type SqlFileSystemStorage, type VfsSqlStorage } from "../src/vfs/sql.js";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

/**
 * A version-1 database, as it was before links existed.
 *
 * Copied rather than imported on purpose: the point of the migration test is
 * that a database written by the old code opens correctly under the new code,
 * and reading the shape from the current source would make the test agree with
 * itself no matter what the migration did.
 */
const V1_SCHEMA = `
  CREATE TABLE vfs_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
  );
  CREATE TABLE vfs_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    mutation_epoch TEXT NOT NULL
  );
  CREATE TABLE vfs_path_versions (
    path TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
  ) WITHOUT ROWID;
  CREATE TABLE vfs_opaque_objects (
    id INTEGER PRIMARY KEY,
    r2_key TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    etag TEXT NOT NULL,
    r2_version TEXT NOT NULL,
    verified_sha256 TEXT,
    content_type TEXT,
    retain_until_ms INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
  );
  CREATE TABLE vfs_entries (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
    content_class TEXT CHECK (content_class IN ('inline', 'opaque')),
    opaque_object_id INTEGER,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    mode INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    modified_at_ms INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    CHECK (
      (kind = 'directory' AND content_class IS NULL AND opaque_object_id IS NULL)
      OR (kind = 'file' AND content_class = 'inline' AND opaque_object_id IS NULL)
      OR (kind = 'file' AND content_class = 'opaque' AND opaque_object_id IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX vfs_entries_path ON vfs_entries(path);
  CREATE UNIQUE INDEX vfs_entries_parent_name ON vfs_entries(parent_path, name);
  CREATE INDEX vfs_entries_opaque_object
    ON vfs_entries(opaque_object_id) WHERE opaque_object_id IS NOT NULL;
  CREATE TABLE vfs_inline_chunks (
    entry_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    body BLOB NOT NULL,
    PRIMARY KEY (entry_id, chunk_index)
  ) WITHOUT ROWID;
  CREATE TABLE vfs_upload_sessions (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    expected_mutation_token TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('open', 'verifying', 'committed', 'garbage')),
    verification_token TEXT,
    expected_size_bytes INTEGER,
    expires_at_ms INTEGER NOT NULL,
    verification_lease_until_ms INTEGER,
    create_parents INTEGER NOT NULL CHECK (create_parents IN (0, 1)),
    mode INTEGER,
    content_type TEXT,
    receipt_json TEXT
  ) WITHOUT ROWID;
  CREATE INDEX vfs_upload_expiry ON vfs_upload_sessions(state, expires_at_ms);
  CREATE TABLE vfs_gc_queue (
    r2_key TEXT PRIMARY KEY,
    not_before_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NOT NULL,
    last_error TEXT
  ) WITHOUT ROWID;
  CREATE INDEX vfs_gc_due ON vfs_gc_queue(next_attempt_at_ms, not_before_ms);
  CREATE TABLE vfs_usage (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    inline_bytes INTEGER NOT NULL CHECK (inline_bytes >= 0),
    entries INTEGER NOT NULL CHECK (entries >= 1)
  );
  INSERT INTO vfs_state (singleton, mutation_epoch) VALUES (1, 'epoch-v1');
  INSERT INTO vfs_entries (
    path, parent_path, name, kind, content_class, opaque_object_id,
    size_bytes, mode, created_at_ms, modified_at_ms, revision
  ) VALUES ('/', '/', '/', 'directory', NULL, NULL, 0, 16877, 0, 0, 1);
  INSERT INTO vfs_entries (
    path, parent_path, name, kind, content_class, opaque_object_id,
    size_bytes, mode, created_at_ms, modified_at_ms, revision
  ) VALUES ('/kept.txt', '/', 'kept.txt', 'file', 'inline', NULL, 5, 33188, 0, 0, 1);
  INSERT INTO vfs_path_versions (path, version) VALUES ('/', 1), ('/kept.txt', 1);
  INSERT INTO vfs_usage (singleton, inline_bytes, entries) VALUES (1, 5, 2);
  INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (1, 0);
`;

function openOver(database: DatabaseSync): SqlFileSystem {
  const sql: VfsSqlStorage = {
    get databaseSize() {
      return 0;
    },
    exec(query, ...bindings) {
      const statement = database.prepare(query);
      const rows = statement.all(...(bindings as never[]));
      return {
        one: () => rows[0] as never,
        toArray: () => rows as never[],
      };
    },
  };
  let open = false;
  const storage: SqlFileSystemStorage = {
    sql,
    execBatch: (query) => database.exec(query),
    transactionSync(callback) {
      if (open) return callback();
      open = true;
      database.exec("BEGIN");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        open = false;
      }
    },
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  return new SqlFileSystem(storage);
}

/**
 * The part of the schema the migration rebuilds, as SQLite reports it.
 *
 * Scoped to the entry table, its indexes, and the triggers, because those are
 * what version 2 recreates. The other tables are carried across untouched and
 * keep whatever text created them, which here is this file's own formatting.
 */
function schemaOf(database: DatabaseSync): string[] {
  return database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name LIKE 'vfs_entries%' OR type = 'trigger' ORDER BY type, name`,
    )
    .all()
    .map((row) => `${String(row["type"])} ${String(row["name"])}: ${String(row["sql"] ?? "")}`);
}

describe("symlink schema", () => {
  it("migrates a version-1 database to exactly the fresh shape", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(V1_SCHEMA);
    const migrated = openOver(old);
    // The rows that were there survive, and the new column is null for them.
    expect(migrated.stat("/kept.txt").sizeBytes).toBe(5);
    expect(migrated.stat("/").kind).toBe("directory");

    const fresh = new DatabaseSync(":memory:");
    openOver(fresh);
    expect(schemaOf(old)).toEqual(schemaOf(fresh));

    // And the migrated database can hold what the new one can.
    migrated.symlink("/link", "/kept.txt");
    expect(migrated.readlink("/link")).toBe("/kept.txt");
    old.close();
    fresh.close();
  });

  it("cannot represent an entry that is two things at once", () => {
    const database = new DatabaseSync(":memory:");
    openOver(database);
    const insert = (kind: string, contentClass: string | null, target: string | null): void => {
      database
        .prepare(
          `INSERT INTO vfs_entries (
             path, parent_path, name, kind, content_class, opaque_object_id,
             link_target, size_bytes, mode, created_at_ms, modified_at_ms, revision
           ) VALUES ('/bad', '/', 'bad', ?, ?, NULL, ?, 0, 0, 0, 0, 1)`,
        )
        .run(kind, contentClass, target);
    };
    // A link with no target, a link that also has content, a directory with a
    // target, and a file with one are all refused by SQLite itself.
    expect(() => insert("symlink", null, null)).toThrowError();
    expect(() => insert("symlink", "inline", "/t")).toThrowError();
    expect(() => insert("directory", null, "/t")).toThrowError();
    expect(() => insert("file", "inline", "/t")).toThrowError();
    expect(() => insert("symlink", null, "")).toThrowError();
    // The valid shape is accepted.
    expect(() => insert("symlink", null, "/t")).not.toThrowError();
    database.close();
  });
});

describe("symlink resolution", () => {
  it("resolves absolute, relative, nested, and directory links", async () => {
    const fs = createTestFileSystem();
    await fs.writeFile("/t/real.txt", "body\n", { createParents: true });
    await fs.mkdir("/t/sub", true);
    await fs.writeFile("/t/sub/deep.txt", "deep\n");

    fs.symlink("/t/rel", "real.txt");
    fs.symlink("/t/abs", "/t/real.txt");
    fs.symlink("/dirlink", "/t/sub");
    fs.symlink("/hop", "/t/rel");

    // A relative target reads from the link's own parent, not the caller's cwd.
    expect(fs.stat("/t/rel").path).toBe("/t/real.txt");
    expect(fs.stat("/t/abs").path).toBe("/t/real.txt");
    // A link in the middle of a path is followed.
    expect(fs.stat("/dirlink/deep.txt").path).toBe("/t/sub/deep.txt");
    // A link to a link is followed to the end.
    expect(fs.stat("/hop").path).toBe("/t/real.txt");
    expect(fs.realpath("/hop")).toBe("/t/real.txt");
    // `lstat` stops at the link, and reports the target verbatim.
    expect(fs.lstat("/t/rel")).toMatchObject({ kind: "symlink", linkTarget: "real.txt" });
    expect(fs.readlink("/t/rel")).toBe("real.txt");
  });

  it("keeps a link from becoming the parent of an entry", async () => {
    const fs = createTestFileSystem();
    await fs.mkdir("/target", true);
    fs.symlink("/dirlink", "/target");
    await fs.writeFile("/dirlink/made.txt", "x\n");
    // The entry lands at its canonical path, so an exact lookup can be trusted.
    expect(fs.lstat("/target/made.txt").kind).toBe("file");
    // Nothing is stored under the link's own path, so an exact-path hit can
    // be trusted without walking components.
    expect(fs.find({ path: "/target", includeRoot: true }).map((entry) => entry.path)).toEqual([
      "/target",
      "/target/made.txt",
    ]);
    expect(fs.realpath("/dirlink/made.txt")).toBe("/target/made.txt");
    // A link to a file is not a directory to create under.
    fs.symlink("/filelink", "/target/made.txt");
    await expect(
      fs.writeFile("/filelink/nope.txt", "x\n", { createParents: true }),
    ).rejects.toThrowError(/ENOTDIR|not a directory/u);
  });

  it("refuses a cycle and excessive indirection with a bounded hop count", async () => {
    const fs = createTestFileSystem();
    fs.symlink("/a", "/b");
    fs.symlink("/b", "/a");
    expect(() => fs.stat("/a")).toThrowError(/too many levels of symbolic links/u);
    // A chain longer than the bound is refused the same way, so the limit does
    // not depend on the cycle being a cycle.
    for (let index = 0; index < 60; index += 1) fs.symlink(`/c${index}`, `/c${index + 1}`);
    expect(() => fs.stat("/c0")).toThrowError(/too many levels of symbolic links/u);
    // A chain inside the bound still resolves.
    await fs.writeFile("/end.txt", "x\n");
    fs.symlink("/d0", "/end.txt");
    for (let index = 1; index < 20; index += 1) fs.symlink(`/d${index}`, `/d${index - 1}`);
    expect(fs.stat("/d19").path).toBe("/end.txt");
  });

  it("treats a dangling link as present but unresolvable", async () => {
    const fs = createTestFileSystem();
    fs.symlink("/dangling", "/nowhere");
    expect(fs.lstat("/dangling").kind).toBe("symlink");
    expect(() => fs.stat("/dangling")).toThrowError(/no such file or directory/u);
    // Creating one is allowed, so the order a tree is restored in does not
    // matter; writing through it creates the target.
    await fs.writeFile("/dangling", "made\n");
    expect(fs.stat("/nowhere").sizeBytes).toBe(5);
    expect(fs.lstat("/dangling").kind).toBe("symlink");
  });

  it("separates the link's revision and mutation token from its target's", async () => {
    const fs = createTestFileSystem();
    await fs.writeFile("/target.txt", "one\n");
    fs.symlink("/link.txt", "/target.txt");
    const linkToken = fs.getMutationToken("/link.txt");

    await fs.writeFile("/target.txt", "two\n", { disposition: "replace" });
    // Writing the target does not disturb the link: the link did not change.
    expect(fs.getMutationToken("/link.txt")).toBe(linkToken);
    const targetToken = fs.getMutationToken("/target.txt");

    fs.symlink("/link.txt", "/elsewhere", { replace: true, ifMutationToken: linkToken });
    expect(fs.readlink("/link.txt")).toBe("/elsewhere");
    // Replacing the link bumps the link's token and leaves the target's alone.
    expect(fs.getMutationToken("/link.txt")).not.toBe(linkToken);
    expect(fs.getMutationToken("/target.txt")).toBe(targetToken);
    expect(fs.stat("/target.txt").sizeBytes).toBe(4);

    // The token that was current a moment ago is refused, so a caller that
    // read the link, decided, and came back cannot overwrite a newer decision.
    expect(() =>
      fs.symlink("/link.txt", "/third", { replace: true, ifMutationToken: linkToken }),
    ).toThrowError(/mutation token/u);
    expect(fs.readlink("/link.txt")).toBe("/elsewhere");
  });

  it("costs a namespace without links exactly what it cost before", async () => {
    const queries: string[] = [];
    const fs = createTestFileSystem({ onStatement: (query) => queries.push(query) });
    await fs.writeFile("/a/b/c.txt", "x\n", { createParents: true });

    queries.length = 0;
    fs.stat("/a/b/c.txt");
    const withoutLinks = queries.length;

    // One link somewhere else must not change what an unrelated lookup costs.
    fs.symlink("/unrelated", "/a");
    queries.length = 0;
    fs.stat("/a/b/c.txt");
    expect(queries.length).toBe(withoutLinks);

    // Resolving through a link costs one more lookup per hop, not one per
    // component and nothing proportional to the size of the namespace.
    queries.length = 0;
    fs.stat("/unrelated/b/c.txt");
    expect(queries.length).toBeLessThanOrEqual(withoutLinks + 3);
  });
});

describe("symlink policy", () => {
  it("cannot be escaped through a link", async () => {
    const harness = createBashHarness({
      policy: { writeRoots: ["/allowed"], readRoots: ["/allowed"] },
    });
    await harness.fileSystem.writeFile("/allowed/ok.txt", "in\n", { createParents: true });
    await harness.fileSystem.writeFile("/secret.txt", "out\n", { createParents: true });
    await harness.fileSystem.mkdir("/secrets", true);
    await harness.fileSystem.writeFile("/secrets/deep.txt", "deep\n");
    harness.fileSystem.symlink("/allowed/escape", "/secret.txt");
    harness.fileSystem.symlink("/allowed/escape-dir", "/secrets");

    expect((await harness.run("cat /allowed/ok.txt")).stdout).toBe("in\n");
    // Reading, writing, and reaching through a directory link all stop at the
    // root check, which is made against what the path resolves to.
    for (const script of [
      "cat /allowed/escape",
      "cat /allowed/escape-dir/deep.txt",
      "printf x > /allowed/escape",
      "ls /allowed/escape-dir",
    ]) {
      const result = await harness.run(script);
      expect(result.exitCode, script).not.toBe(0);
      expect(result.stdout, script).toBe("");
    }
    expect(await harness.readText("/secret.txt")).toBe("out\n");
  });
});
