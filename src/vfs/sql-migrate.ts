import { DIRECTORY_MODE } from "./config.js";
import { integerColumn, type SqlRow, stringColumn, type VfsSqlStorage } from "./sql-model.js";
import { DROP_ENTRY_TRIGGERS, ENTRIES_SCHEMA, ENTRY_TRIGGERS } from "./sql-schema.js";

export interface SqlMigrationContext {
  readonly sql: VfsSqlStorage;
  readonly transaction: <T>(callback: () => T) => T;
  readonly execBatch: (query: string) => void;
  readonly now: () => number;
  readonly newToken: () => string;
}

export function migrateSql(context: SqlMigrationContext): string {
  let migrated = false;
  const mutationEpoch = context.transaction(() =>
    migrateTransaction(context, () => {
      migrated = true;
    }),
  );
  if (migrated) context.sql.exec("PRAGMA optimize");
  return mutationEpoch;
}

function migrateTransaction(context: SqlMigrationContext, markMigrated: () => void): string {
  context.sql.exec(`
      CREATE TABLE IF NOT EXISTS vfs_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
    `);
  const currentVersion = integerColumn(
    context.sql
      .exec<SqlRow>("SELECT COALESCE(MAX(version), 0) AS version FROM vfs_schema_migrations")
      .one(),
    "version",
  );
  const now = context.now();
  if (currentVersion < 1) {
    context.execBatch(`
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
${ENTRIES_SCHEMA}
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
${ENTRY_TRIGGERS}
      `);
    const now = context.now();
    context.sql.exec(
      `INSERT INTO vfs_state (singleton, mutation_epoch)
         VALUES (1, ?)`,
      context.newToken(),
    );
    context.sql.exec("INSERT INTO vfs_path_versions (path, version) VALUES ('/', 1)");
    context.sql.exec(
      `INSERT INTO vfs_entries (
           path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
         ) VALUES ('/', '/', '/', 'directory', NULL, NULL, 0, ?, 0, 0, 0, 0, 1)`,
      DIRECTORY_MODE,
    );
    context.sql.exec("INSERT INTO vfs_usage (singleton, inline_bytes, entries) VALUES (1, 0, 1)");
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (1, ?)",
      now,
    );
    markMigrated();
  }
  if (currentVersion < 2) {
    // SQLite cannot widen a CHECK constraint in place, so version 2 is the
    // standard rebuild: create the new shape, copy every row, swap. The
    // definition comes from `ENTRIES_SCHEMA`, the same text a fresh
    // database uses, so a migrated database and a new one cannot differ.
    if (currentVersion === 1) {
      context.execBatch(`
${DROP_ENTRY_TRIGGERS}
      ALTER TABLE vfs_entries RENAME TO vfs_entries_v1;
      DROP INDEX vfs_entries_path;
      DROP INDEX vfs_entries_parent_name;
      DROP INDEX vfs_entries_opaque_object;
${ENTRIES_SCHEMA}
      INSERT INTO vfs_entries (
        id, path, parent_path, name, kind, content_class, opaque_object_id,
        link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
      )
      SELECT
        id, path, parent_path, name, kind, content_class, opaque_object_id,
        NULL, size_bytes, mode, 0, 0, created_at_ms, modified_at_ms, revision
      FROM vfs_entries_v1;
      DROP TABLE vfs_entries_v1;
${ENTRY_TRIGGERS}
    `);
    }
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (2, ?)",
      now,
    );
    markMigrated();
  }
  if (currentVersion < 3) {
    // Databases rebuilt above already use the current entry definition.
    // Only a database that was already at version 2 needs the two columns
    // added in place; existing entries become root-owned until a trusted
    // administrator assigns workspace ownership explicitly.
    if (currentVersion === 2) {
      context.execBatch(`
      ALTER TABLE vfs_entries
        ADD COLUMN uid INTEGER NOT NULL DEFAULT 0
        CHECK (uid >= 0 AND uid <= 4294967295);
      ALTER TABLE vfs_entries
        ADD COLUMN gid INTEGER NOT NULL DEFAULT 0
        CHECK (gid >= 0 AND gid <= 4294967295);
    `);
    }
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (3, ?)",
      now,
    );
    markMigrated();
  }
  if (currentVersion < 4) {
    // Unconditional, including for a database created moments ago by the
    // version-1 branch above. Adding the column there instead would leave
    // a fresh database describing the table one way and a migrated one
    // another, which is exactly the drift the shared definitions elsewhere
    // exist to prevent. Every path recorded before this starts at zero and
    // is therefore never reported: the feed says what changed after
    // recording began, and inventing changes for a namespace that was
    // already there would make the first page a full listing wearing a
    // cursor's clothes. The index is partial for the same reason — a
    // workspace with the cursor off stamps nothing and carries no index
    // entries at all.
    context.execBatch(`
      ALTER TABLE vfs_path_versions
        ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX vfs_path_changes
        ON vfs_path_versions(change_seq) WHERE change_seq > 0;
    `);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (4, ?)",
      now,
    );
    markMigrated();
  }
  if (currentVersion < 5) {
    // One column, and no table rebuild: entry identities keep the numbers
    // they already have, because renumbering them would be exactly the
    // reuse this exists to prevent.
    //
    // `next_ino` is where never reusing one comes from. AUTOINCREMENT was
    // measured for the same job and rejected — it reads and writes
    // `sqlite_sequence` on every creation, which costs +512 rows written
    // and +512 rows read across 512 creates and one more row read on every
    // overwrite. This column rides the usage UPDATE that every creation
    // already performs, so the guarantee costs nothing. Anything that
    // removes it as unused brings the recycling back.
    context.execBatch(`
      ALTER TABLE vfs_usage
        ADD COLUMN next_ino INTEGER NOT NULL DEFAULT 1;
    `);
    // Seeded above the highest identity already in use, so an existing
    // workspace continues its sequence rather than handing out numbers
    // its entries already hold.
    context.sql.exec(
      `UPDATE vfs_usage
           SET next_ino = (SELECT COALESCE(MAX(id), 0) + 1 FROM vfs_entries)
         WHERE singleton = 1`,
    );
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (5, ?)",
      now,
    );
    markMigrated();
  }
  if (currentVersion < 6) {
    // Unconditional, including for a database created moments ago by the
    // version-1 branch above, for the reason the version-4 branch gives:
    // adding it to the shared definition instead would leave a fresh
    // database describing the table one way and a migrated one another.
    //
    // A cache for `skipIfUnchanged`, never a promise to a caller. The
    // digest is stamped with the revision it was taken at and trusted only
    // while that still matches, so a write path that forgets to clear it
    // loses the optimisation and cannot produce a wrong answer -- every
    // content change bumps the revision, which is what makes that
    // structural rather than remembered.
    //
    // No backfill. An existing entry has no digest, and the first
    // `skipIfUnchanged` write that publishes over it records one; hashing
    // every stored body here would charge a migration for a cache that
    // fills itself.
    context.execBatch(`
      ALTER TABLE vfs_entries ADD COLUMN body_digest TEXT;
      ALTER TABLE vfs_entries ADD COLUMN body_digest_revision INTEGER;
    `);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (6, ?)",
      now,
    );
    markMigrated();
  }
  if (currentVersion < 7) {
    // Live paths carry their mutation version on the entry row that every
    // stat/list operation already reads. Only removed paths need a
    // tombstone, and only workspaces with the change cursor enabled write
    // the independent latest-change table.
    //
    // The column is added here even for a fresh database so fresh and
    // upgraded schemas have equivalent table definitions. Existing live
    // versions and cursor state are copied before the combined table is
    // dropped; no token or unread change is reset.
    context.execBatch(`
      ALTER TABLE vfs_entries
        ADD COLUMN mutation_version INTEGER NOT NULL DEFAULT 1
        CHECK (mutation_version >= 1);
      UPDATE vfs_entries
         SET mutation_version = (
           SELECT version FROM vfs_path_versions WHERE path = vfs_entries.path
         );
      DROP INDEX vfs_path_changes;
      CREATE TABLE vfs_path_tombstones (
        path TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      ) WITHOUT ROWID;
      INSERT INTO vfs_path_tombstones (path, version)
      SELECT versions.path, versions.version
        FROM vfs_path_versions versions
       WHERE NOT EXISTS (
         SELECT 1 FROM vfs_entries entries WHERE entries.path = versions.path
       );
      CREATE TABLE vfs_path_changes (
        path TEXT PRIMARY KEY,
        change_seq INTEGER NOT NULL CHECK (change_seq >= 1),
        present INTEGER NOT NULL CHECK (present IN (0, 1))
      ) WITHOUT ROWID;
      INSERT INTO vfs_path_changes (path, change_seq, present)
      SELECT versions.path, versions.change_seq,
             EXISTS (SELECT 1 FROM vfs_entries entries WHERE entries.path = versions.path)
        FROM vfs_path_versions versions
       WHERE versions.change_seq > 0;
      CREATE INDEX vfs_path_changes_sequence
        ON vfs_path_changes(change_seq, path);
      DROP TABLE vfs_path_versions;
    `);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (7, ?)",
      now,
    );
    markMigrated();
  }
  if (currentVersion < 8) {
    migrateMaintenanceIndexes(context, now);
    markMigrated();
  }
  return stringColumn(
    context.sql.exec<SqlRow>("SELECT mutation_epoch FROM vfs_state WHERE singleton = 1").one(),
    "mutation_epoch",
  );
}

function migrateMaintenanceIndexes(context: SqlMigrationContext, now: number): void {
  context.execBatch(`
      CREATE INDEX vfs_gc_earliest
        ON vfs_gc_queue(MAX(not_before_ms, next_attempt_at_ms));
      CREATE INDEX vfs_upload_verification_expiry
        ON vfs_upload_sessions(verification_lease_until_ms) WHERE state = 'verifying';
    `);
  context.sql.exec("INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (8, ?)", now);
}
