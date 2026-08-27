import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlFileSystem, type SqlFileSystemStorage, type VfsSqlStorage } from "../src/vfs/sql.js";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function readAll(
  fs: { readFile: (path: string) => { stream: ReadableStream<Uint8Array> } },
  path: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = fs.readFile(path).stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return new TextDecoder().decode(
    chunks.reduce<Uint8Array>((all, chunk) => {
      const merged = new Uint8Array(all.length + chunk.length);
      merged.set(all);
      merged.set(chunk, all.length);
      return merged;
    }, new Uint8Array()),
  );
}

/**
 * A version-1 database, exactly as the previous release wrote one.
 *
 * The DDL is copied verbatim from `origin/main` rather than imported, because
 * the point of the test is that a database written by the old code opens under
 * the new code. Reading the shape from the current source would make the test
 * agree with itself no matter what the migration did — and in particular would
 * hide that the old schema carries six triggers, two of which are attached to
 * tables the rebuild does not touch.
 *
 * The seed rows are chosen to exercise what the rebuild moves: an inline file
 * with a chunk joined by entry id, an opaque entry with a live object
 * reference, a path version above 1, and a queued GC key.
 */
const V1_SCHEMA = `
        CREATE TABLE IF NOT EXISTS vfs_schema_migrations (
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
        CREATE UNIQUE INDEX vfs_entries_path
          ON vfs_entries(path);
        CREATE UNIQUE INDEX vfs_entries_parent_name
          ON vfs_entries(parent_path, name);
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
        CREATE INDEX vfs_upload_expiry
          ON vfs_upload_sessions(state, expires_at_ms);
        CREATE TABLE vfs_gc_queue (
          r2_key TEXT PRIMARY KEY,
          not_before_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER NOT NULL,
          last_error TEXT
        ) WITHOUT ROWID;
        CREATE INDEX vfs_gc_due
          ON vfs_gc_queue(next_attempt_at_ms, not_before_ms);
        CREATE TABLE vfs_usage (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          inline_bytes INTEGER NOT NULL CHECK (inline_bytes >= 0),
          entries INTEGER NOT NULL CHECK (entries >= 1)
        );
        CREATE TRIGGER vfs_opaque_entry_insert_guard
          BEFORE INSERT ON vfs_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER vfs_opaque_entry_update_guard
          BEFORE UPDATE OF content_class, opaque_object_id ON vfs_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER vfs_opaque_object_delete_guard
          BEFORE DELETE ON vfs_opaque_objects
          WHEN EXISTS (
            SELECT 1 FROM vfs_entries WHERE opaque_object_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object is still referenced'); END;
        CREATE TRIGGER vfs_inline_chunk_insert_guard
          BEFORE INSERT ON vfs_inline_chunks
          WHEN NOT EXISTS (
            SELECT 1 FROM vfs_entries
            WHERE id = NEW.entry_id AND content_class = 'inline'
          )
          BEGIN SELECT RAISE(ABORT, 'inline chunk has no inline entry'); END;
        CREATE TRIGGER vfs_inline_entry_delete_guard
          BEFORE DELETE ON vfs_entries
          WHEN EXISTS (
            SELECT 1 FROM vfs_inline_chunks WHERE entry_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;
        CREATE TRIGGER vfs_inline_entry_update_guard
          BEFORE UPDATE OF content_class ON vfs_entries
          WHEN OLD.content_class = 'inline' AND NEW.content_class <> 'inline'
            AND EXISTS (
              SELECT 1 FROM vfs_inline_chunks WHERE entry_id = OLD.id
            )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;

  INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (1, 0);
  INSERT INTO vfs_state (singleton, mutation_epoch) VALUES (1, 'epoch-v1');
  INSERT INTO vfs_entries (
    path, parent_path, name, kind, content_class, opaque_object_id,
    size_bytes, mode, created_at_ms, modified_at_ms, revision
  ) VALUES ('/', '/', '/', 'directory', NULL, NULL, 0, 16877, 0, 0, 1);
  INSERT INTO vfs_entries (
    path, parent_path, name, kind, content_class, opaque_object_id,
    size_bytes, mode, created_at_ms, modified_at_ms, revision
  ) VALUES ('/kept.txt', '/', 'kept.txt', 'file', 'inline', NULL, 5, 33188, 0, 0, 1);
  INSERT INTO vfs_entries (
    path, parent_path, name, kind, content_class, opaque_object_id,
    size_bytes, mode, created_at_ms, modified_at_ms, revision
  ) VALUES ('/d', '/', 'd', 'directory', NULL, NULL, 0, 16877, 0, 0, 1);
  INSERT INTO vfs_opaque_objects (id, r2_key, size_bytes, etag, r2_version, created_at_ms)
    VALUES (1, 'k/1', 9, 'etag-1', 'v1', 0);
  INSERT INTO vfs_entries (
    path, parent_path, name, kind, content_class, opaque_object_id,
    size_bytes, mode, created_at_ms, modified_at_ms, revision
  ) VALUES ('/d/big.bin', '/d', 'big.bin', 'file', 'opaque', 1, 9, 33188, 0, 0, 1);
  INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body)
    SELECT id, 0, x'626f64790a' FROM vfs_entries WHERE path = '/kept.txt';
  INSERT INTO vfs_path_versions (path, version)
    VALUES ('/', 1), ('/kept.txt', 3), ('/d', 1), ('/d/big.bin', 1);
  INSERT INTO vfs_gc_queue (r2_key, not_before_ms, next_attempt_at_ms) VALUES ('k/old', 0, 0);
  INSERT INTO vfs_usage (singleton, inline_bytes, entries) VALUES (1, 5, 4);
`;

/**
 * The minimal readable shape of a version-2 database.
 *
 * `vfs_entries` is copied verbatim from the version-2 release. The fixture
 * intentionally includes only the other tables touched while opening it and
 * reading the two seeded entries: this test is specifically for the in-place
 * version-3 ownership migration, while the fuller version-1 fixture above
 * covers cross-table data and trigger preservation.
 */
const V2_SCHEMA = `
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
  CREATE TABLE vfs_entries (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('directory', 'file', 'symlink')),
    content_class TEXT CHECK (content_class IN ('inline', 'opaque')),
    opaque_object_id INTEGER,
    link_target TEXT,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    mode INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    modified_at_ms INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    CHECK (
      (kind = 'directory' AND content_class IS NULL AND opaque_object_id IS NULL
        AND link_target IS NULL)
      OR (kind = 'file' AND content_class = 'inline' AND opaque_object_id IS NULL
        AND link_target IS NULL)
      OR (kind = 'file' AND content_class = 'opaque' AND opaque_object_id IS NOT NULL
        AND link_target IS NULL)
      OR (kind = 'symlink' AND content_class IS NULL AND opaque_object_id IS NULL
        AND link_target IS NOT NULL AND length(link_target) > 0)
    )
  );
  CREATE UNIQUE INDEX vfs_entries_path ON vfs_entries(path);
  CREATE UNIQUE INDEX vfs_entries_parent_name ON vfs_entries(parent_path, name);
  CREATE INDEX vfs_entries_opaque_object
    ON vfs_entries(opaque_object_id) WHERE opaque_object_id IS NOT NULL;
  CREATE INDEX vfs_entries_symlink
    ON vfs_entries(path) WHERE kind = 'symlink';

  CREATE TABLE vfs_usage (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    inline_bytes INTEGER NOT NULL CHECK (inline_bytes >= 0),
    entries INTEGER NOT NULL CHECK (entries >= 1)
  );

  INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (1, 0), (2, 0);
  INSERT INTO vfs_state (singleton, mutation_epoch) VALUES (1, 'epoch-v2');
  INSERT INTO vfs_usage (singleton, inline_bytes, entries) VALUES (1, 5, 2);
  INSERT INTO vfs_path_versions (path, version) VALUES ('/', 1), ('/kept.txt', 7);
  INSERT INTO vfs_entries (
    path, parent_path, name, kind, content_class, opaque_object_id, link_target,
    size_bytes, mode, created_at_ms, modified_at_ms, revision
  ) VALUES
    ('/', '/', '/', 'directory', NULL, NULL, NULL, 0, 16877, 0, 0, 1),
    ('/kept.txt', '/', 'kept.txt', 'file', 'inline', NULL, NULL, 5, 33188, 0, 0, 2);
`;

function openOver(database: DatabaseSync): SqlFileSystem {
  const sql: VfsSqlStorage = {
    get databaseSize() {
      return 0;
    },
    exec(query, ...bindings) {
      const statement = database.prepare(query);
      // The same conversion the Durable Object storage does: BLOBs arrive as
      // `Uint8Array` from node:sqlite and the filesystem expects `ArrayBuffer`.
      const rows = statement
        .all(...(bindings as never[]))
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([name, value]) => [
              name,
              value instanceof Uint8Array ? value.slice().buffer : value,
            ]),
          ),
        );
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
 * what the current migrations recreate. The other tables are carried across untouched and
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
    // Existing rows survive: links default to no target and ownership to 0:0.
    expect(migrated.stat("/kept.txt")).toMatchObject({ sizeBytes: 5, uid: 0, gid: 0 });
    expect(migrated.stat("/").kind).toBe("directory");

    const fresh = new DatabaseSync(":memory:");
    openOver(fresh);
    expect(schemaOf(old)).toEqual(schemaOf(fresh));

    // The rows that were carried across kept their identities and their joins:
    // the inline chunk still belongs to its entry, the opaque entry still
    // references its object, and a path version above 1 survived.
    expect(migrated.readFile("/kept.txt").stat.sizeBytes).toBe(5);
    expect(migrated.stat("/d/big.bin")).toMatchObject({ contentClass: "opaque" });
    expect(migrated.getMutationToken("/kept.txt")).toMatch(/:3$/u);

    // The guards are not merely present in `sqlite_master`; they still abort.
    // Two of them had their bodies rewritten by the rename, so a migration
    // that only recreated the entry-table ones would leave these pointing at a
    // table that no longer exists.
    expect(() => old.prepare("DELETE FROM vfs_opaque_objects WHERE id = 1").run()).toThrowError(
      /still referenced/u,
    );
    expect(() =>
      old
        .prepare("INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body) VALUES (9, 0, x'00')")
        .run(),
    ).toThrowError(/no inline entry/u);

    // And the migrated database can hold what the new one can.
    migrated.symlink("/link", "/kept.txt");
    expect(migrated.readlink("/link")).toBe("/kept.txt");
    old.close();
    fresh.close();
  });

  it("migrates a version-2 database to root-owned entries in place", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(V2_SCHEMA);

    const migrated = openOver(database);

    expect(migrated.stat("/")).toMatchObject({ uid: 0, gid: 0 });
    expect(migrated.stat("/kept.txt")).toMatchObject({
      sizeBytes: 5,
      revision: 2,
      uid: 0,
      gid: 0,
    });
    expect(migrated.getMutationToken("/kept.txt")).toBe("epoch-v2:7");
    expect(
      database
        .prepare("SELECT GROUP_CONCAT(version, ',') AS versions FROM vfs_schema_migrations")
        .get()?.["versions"],
    ).toBe("1,2,3,4,5,6");
    // The version-6 columns exist on a migrated database and carry nothing:
    // the digest cache is filled by use rather than backfilled by a migration.
    expect(
      database
        .prepare(
          "SELECT body_digest AS digest, body_digest_revision AS stamp FROM vfs_entries WHERE path = '/kept.txt'",
        )
        .get(),
    ).toEqual({ digest: null, stamp: null });
    expect(() =>
      database.prepare("UPDATE vfs_entries SET uid = -1 WHERE path = '/kept.txt'").run(),
    ).toThrowError();
    expect(() =>
      database.prepare("UPDATE vfs_entries SET gid = 4294967296 WHERE path = '/kept.txt'").run(),
    ).toThrowError();
    database.close();
  });

  it("describes the change cursor identically whether fresh or migrated", () => {
    // Version 4 alters `vfs_path_versions` unconditionally rather than adding
    // the column to the version-1 definition, so both paths reach the same
    // `sqlite_master` text. Declaring it inline for a fresh database would
    // leave the two describing the same table differently.
    function cursorSchema(database: DatabaseSync): unknown[] {
      return database
        .prepare(
          `SELECT type, name, sql FROM sqlite_master
           WHERE name LIKE 'vfs_path_%' ORDER BY type, name`,
        )
        .all();
    }

    const upgraded = new DatabaseSync(":memory:");
    upgraded.exec(V1_SCHEMA);
    openOver(upgraded);

    const fresh = new DatabaseSync(":memory:");
    openOver(fresh);

    expect(cursorSchema(upgraded)).toEqual(cursorSchema(fresh));
    // Every path recorded before the cursor existed starts at zero, so a
    // caller reading from zero is told about all of them.
    expect(
      upgraded.prepare("SELECT COUNT(*) AS n FROM vfs_path_versions WHERE change_seq = 0").get()?.[
        "n"
      ],
    ).toBeGreaterThan(0);
    upgraded.close();
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
             link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
           ) VALUES ('/bad', '/', 'bad', ?, ?, NULL, ?, 0, 0, 0, 0, 0, 0, 1)`,
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
    expect(() =>
      database.prepare("UPDATE vfs_entries SET uid = -1 WHERE path = '/bad'").run(),
    ).toThrowError();
    expect(() =>
      database.prepare("UPDATE vfs_entries SET gid = 4294967296 WHERE path = '/bad'").run(),
    ).toThrowError();
    database.close();
  });
});

describe("symlink resolution", () => {
  it("does not reinterpret an inferred link name as a destination directory", async () => {
    const harness = createBashHarness();
    harness.fileSystem.mkdir("/foo");

    const result = await harness.run("ln -s /missing/foo");

    expect(result.exitCode).toBe(1);
    expect(harness.fileSystem.list("/foo")).toEqual([]);
  });

  it("infers a link name from a target with trailing slashes", async () => {
    const harness = createBashHarness();

    const result = await harness.run("ln -s /missing/bar/");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(harness.fileSystem.lstat("/bar")).toMatchObject({
      kind: "symlink",
      linkTarget: "/missing/bar/",
    });
  });

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
    // Twice, so the link and the target sit at different path versions and no
    // assertion below can pass by coincidence.
    await fs.writeFile("/target.txt", "one\n", { disposition: "replace" });
    fs.symlink("/link.txt", "/target.txt");
    const link = (): string => fs.getMutationToken("/link.txt", { follow: false });
    const linkToken = link();

    // The default follows, so a token read through the link covers the target
    // — it has to, or it would never match the write it is meant to guard —
    // and also the link, so repointing the link invalidates it.
    const through = fs.getMutationToken("/link.txt");
    expect(through).toContain(fs.getMutationToken("/target.txt"));
    expect(through).toContain(linkToken);
    expect(linkToken).not.toBe(fs.getMutationToken("/target.txt"));

    await fs.writeFile("/target.txt", "two\n", { disposition: "replace" });
    // Writing the target does not disturb the link: the link did not change.
    expect(link()).toBe(linkToken);
    const targetToken = fs.getMutationToken("/target.txt");

    fs.symlink("/link.txt", "/elsewhere", { replace: true, ifMutationToken: linkToken });
    expect(fs.readlink("/link.txt")).toBe("/elsewhere");
    // Replacing the link bumps the link's token and leaves the target's alone.
    expect(link()).not.toBe(linkToken);
    expect(fs.getMutationToken("/target.txt")).toBe(targetToken);
    expect(fs.stat("/target.txt").sizeBytes).toBe(4);

    // The token that was current a moment ago is refused, so a caller that
    // read the link, decided, and came back cannot overwrite a newer decision.
    expect(() =>
      fs.symlink("/link.txt", "/third", { replace: true, ifMutationToken: linkToken }),
    ).toThrowError(/mutation token/u);
    expect(fs.readlink("/link.txt")).toBe("/elsewhere");
  });

  it("guards a write through a link with the target's token", async () => {
    const fs = createTestFileSystem();
    await fs.writeFile("/target.txt", "one\n");
    // Two writes, so the link and the target are at different path versions
    // and a guard read from the wrong one cannot match by coincidence.
    await fs.writeFile("/target.txt", "two\n", { disposition: "replace" });
    fs.symlink("/link.txt", "/target.txt");
    const token = fs.getMutationToken("/link.txt");
    await fs.writeFile("/link.txt", "three\n", {
      disposition: "replace",
      ifMutationToken: token,
    });
    expect(await readAll(fs, "/target.txt")).toBe("three\n");
    expect(fs.lstat("/link.txt").kind).toBe("symlink");
  });

  it("refuses a guarded write when the link was repointed underneath it", async () => {
    const fs = createTestFileSystem();
    await fs.writeFile("/a.txt", "AAA\n");
    await fs.writeFile("/b.txt", "BBB\n");
    fs.symlink("/link", "/a.txt");
    const token = fs.getMutationToken("/link");

    // Both targets sit at the same path version, so a token that named only
    // where the link currently points would match after it was repointed —
    // the path the caller reserved now means a different file.
    fs.symlink("/link", "/b.txt", { replace: true });
    await expect(
      fs.writeFile("/link", "CALLER\n", { disposition: "replace", ifMutationToken: token }),
    ).rejects.toThrowError(/mutation token/u);
    expect(await readAll(fs, "/a.txt")).toBe("AAA\n");
    expect(await readAll(fs, "/b.txt")).toBe("BBB\n");

    // A token taken after the change is accepted, and writes through the link.
    await fs.writeFile("/link", "CALLER\n", {
      disposition: "replace",
      ifMutationToken: fs.getMutationToken("/link"),
    });
    expect(await readAll(fs, "/b.txt")).toBe("CALLER\n");
  });

  it("costs a namespace without links exactly what it cost before", async () => {
    const queries: string[] = [];
    const fs = createTestFileSystem({ onStatement: (query) => queries.push(query) });
    await fs.writeFile("/a/b/c.txt", "x\n", { createParents: true });
    await fs.mkdir("/seed", true);

    const count = (run: () => unknown): number => {
      queries.length = 0;
      run();
      return queries.length;
    };
    const baseline = {
      stat: count(() => fs.stat("/a/b/c.txt")),
      read: count(() => fs.readFile("/a/b/c.txt").stream.cancel()),
      token: count(() => fs.getMutationToken("/a/b/c.txt")),
    };
    // Pinned absolutely, not merely capped: a bound with no floor is satisfied
    // by a meter that stopped counting. These are the counts the filesystem
    // had before links existed, measured on the previous release.
    expect(baseline).toEqual({ stat: 1, read: 2, token: 3 });

    // One link somewhere else must not change what reading an unrelated path
    // costs, because both operations keep the row resolution landed on.
    fs.symlink("/unrelated", "/a");
    expect(count(() => fs.stat("/a/b/c.txt"))).toBe(baseline.stat);
    expect(count(() => fs.readFile("/a/b/c.txt").stream.cancel())).toBe(baseline.read);
    // A token costs one more: it needs the canonical path, and unlike the two
    // above it has no use for the row that resolving it produced.
    expect(count(() => fs.getMutationToken("/a/b/c.txt"))).toBe(baseline.token + 1);

    // Resolving through a link costs one lookup per hop — not one per
    // component, and nothing that grows with the size of the namespace.
    expect(count(() => fs.stat("/unrelated/b/c.txt"))).toBe(baseline.stat + 2);
    for (let index = 0; index < 200; index += 1) {
      await fs.writeFile(`/a/bulk${index}.txt`, "x\n");
    }
    expect(count(() => fs.stat("/unrelated/b/c.txt"))).toBe(baseline.stat + 2);
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

  it("still allows a link that points outside the roots to be removed", async () => {
    const harness = createBashHarness({
      policy: { writeRoots: ["/allowed"], readRoots: ["/allowed"] },
    });
    await harness.fileSystem.mkdir("/allowed", true);
    await harness.fileSystem.writeFile("/secret.txt", "out\n");

    // Creating an escaping link is allowed — a target is text, not an access.
    expect((await harness.run("ln -s /secret.txt /allowed/escape")).exitCode).toBe(0);
    // Following it is refused, but naming it is not: a link that could be made
    // and never removed would be a dead end rather than a protection.
    expect((await harness.run("cat /allowed/escape")).exitCode).not.toBe(0);
    expect((await harness.run("mv /allowed/escape /allowed/renamed")).exitCode).toBe(0);
    expect((await harness.run("readlink /allowed/renamed")).stdout).toBe("/secret.txt\n");
    expect((await harness.run("rm /allowed/renamed")).exitCode).toBe(0);
    expect((await harness.run("ls /allowed")).stdout).toBe("");
    // And the target was never touched.
    expect(await harness.readText("/secret.txt")).toBe("out\n");
  });

  it("refuses to place an entry under a link that replaced its parent", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.mkdir("/directory", true);
    await fileSystem.mkdir("/elsewhere", true);

    // The body is still arriving when the parent is swapped for a link. The
    // write resolved `/directory/new` before that happened, so nothing it
    // captured can notice — the refusal has to come from the parent check.
    let deliver = (): void => {};
    const arrival = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await arrival;
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      },
    });
    const writing = fileSystem.writeFile("/directory/new", body);
    await fileSystem.remove("/directory", { recursive: true });
    await fileSystem.symlink("/directory", "/elsewhere");
    deliver();

    await expect(writing).rejects.toMatchObject({ code: "ENOTDIR" });
    // A link that resolves to a directory is still not one, so no row may name
    // it as a parent: the link can be repointed and the child would remain.
    expect(() => fileSystem.stat("/directory/new")).toThrow();
    expect(fileSystem.list("/elsewhere")).toEqual([]);
  });
});
