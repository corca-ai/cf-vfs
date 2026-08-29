import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SqlFileSystem, type SqlFileSystemStorage, type VfsSqlStorage } from "../src/vfs/sql.js";

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

function openOver(database: DatabaseSync, recordChanges = false): SqlFileSystem {
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
  return new SqlFileSystem(storage, { recordChanges });
}

/**
 * The part of the schema the migration rebuilds, as SQLite reports it.
 *
 * Scoped to the entry table, its indexes, and the triggers, because those are
 * what the entry-shape migrations recreate. Version 7 separately replaces the
 * path-version table; the entry definition remains the part whose constraints
 * and triggers need direct fresh-versus-upgraded comparison here.
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
  ).toBe("1,2,3,4,5,6,7");
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

it("preserves live tokens, tombstones, and unread changes in version 7", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(V2_SCHEMA);
  database.exec(`
      ALTER TABLE vfs_entries ADD COLUMN uid INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vfs_entries ADD COLUMN gid INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vfs_usage ADD COLUMN next_ino INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE vfs_entries ADD COLUMN body_digest TEXT;
      ALTER TABLE vfs_entries ADD COLUMN body_digest_revision INTEGER;
      ALTER TABLE vfs_path_versions ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX vfs_path_changes
        ON vfs_path_versions(change_seq) WHERE change_seq > 0;
      INSERT INTO vfs_schema_migrations (version, applied_at_ms)
        VALUES (3, 0), (4, 0), (5, 0), (6, 0);
      UPDATE vfs_path_versions SET change_seq = 11 WHERE path = '/kept.txt';
      INSERT INTO vfs_path_versions (path, version, change_seq)
        VALUES ('/gone.txt', 9, 12);
    `);

  const migrated = openOver(database, true);
  expect(migrated.getMutationToken("/kept.txt")).toBe("epoch-v2:7");
  expect(migrated.getMutationToken("/gone.txt")).toBe("epoch-v2:9");
  expect(migrated.changesSince(0).changes).toEqual([
    { path: "/kept.txt", present: true },
    { path: "/gone.txt", present: false },
  ]);
  expect(database.prepare("SELECT COUNT(*) AS n FROM vfs_path_tombstones").get()?.["n"]).toBe(1);
  expect(
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM vfs_entries e
           JOIN vfs_path_tombstones t ON t.path = e.path`,
      )
      .get()?.["n"],
  ).toBe(0);
  expect(() => database.prepare("SELECT * FROM vfs_path_versions").all()).toThrowError();
  database.close();
});

it("keeps live rows and tombstones exclusive across point and set mutations", async () => {
  const database = new DatabaseSync(":memory:");
  const fileSystem = openOver(database, true);
  const version = (token: string): number => Number(token.slice(token.lastIndexOf(":") + 1));

  const created = await fileSystem.writeFile("/file", "one");
  await fileSystem.remove("/file");
  const removed = fileSystem.getMutationToken("/file");
  const recreated = await fileSystem.writeFile("/file", "two");
  expect([
    version(created.mutationToken),
    version(removed),
    version(recreated.mutationToken),
  ]).toEqual([1, 2, 3]);

  fileSystem.symlink("/link", "/file");
  const linkBefore = fileSystem.getMutationToken("/link", { follow: false });
  fileSystem.symlink("/link", "/elsewhere", { replace: true });
  expect(version(fileSystem.getMutationToken("/link", { follow: false }))).toBe(
    version(linkBefore) + 1,
  );

  await fileSystem.writeFile("/tree/child", "body", { createParents: true });
  await fileSystem.writeFile("/destination/old", "history", { createParents: true });
  await fileSystem.remove("/destination", { recursive: true });
  const unrelatedTombstone = fileSystem.getMutationToken("/destination/old");
  await fileSystem.copy("/tree", "/destination", { recursive: true });
  expect(fileSystem.getMutationToken("/destination/old")).toBe(unrelatedTombstone);
  await fileSystem.copy("/tree", "/copy", { recursive: true });
  await fileSystem.move("/copy", "/moved");
  await fileSystem.remove("/moved", { recursive: true });
  expect(version(fileSystem.getMutationToken("/copy/child"))).toBe(2);
  expect(version(fileSystem.getMutationToken("/moved/child"))).toBe(2);

  expect(
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM vfs_entries e
           JOIN vfs_path_tombstones t ON t.path = e.path`,
      )
      .get()?.["n"],
  ).toBe(0);
  database.close();
});

it("treats a recent read as a conditional hint rather than trusted state", async () => {
  const database = new DatabaseSync(":memory:");
  const reader = openOver(database);
  const concurrent = openOver(database);
  await reader.writeFile("/file", "one");

  const stale = reader.readFile("/file");
  await stale.stream.cancel();
  await expect(
    reader.writeFile("/file/", "caller", {
      ifMutationToken: stale.stat.mutationToken,
    }),
  ).rejects.toMatchObject({ code: "ENOTDIR" });
  await concurrent.writeFile("/file", "two", {
    ifMutationToken: stale.stat.mutationToken,
  });
  await expect(
    reader.writeFile("/file", "caller", {
      disposition: "replace",
      ifMutationToken: stale.stat.mutationToken,
    }),
  ).rejects.toMatchObject({ code: "EREVISION" });
  expect(await readAll(reader, "/file")).toBe("two");

  const removed = reader.readFile("/file");
  await removed.stream.cancel();
  await concurrent.remove("/file");
  await expect(
    reader.writeFile("/file", "caller", {
      disposition: "replace",
      ifMutationToken: removed.stat.mutationToken,
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  database.close();
});

it("describes the change cursor identically whether fresh or migrated", () => {
  // Versions 4 and 7 run unconditionally, so both paths reach the same
  // `sqlite_master` text even though the live versions are moved onto entries
  // and tombstones/change records become independent tables.
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
  // Paths that predate the cursor do not fabricate changes during migration.
  expect(upgraded.prepare("SELECT COUNT(*) AS n FROM vfs_path_changes").get()?.["n"]).toBe(0);
  expect(upgraded.prepare("SELECT COUNT(*) AS n FROM vfs_path_tombstones").get()?.["n"]).toBe(0);
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
