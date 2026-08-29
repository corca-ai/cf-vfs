export const ENTRIES_SCHEMA = `
        CREATE TABLE vfs_entries (
          -- Assigned from vfs_usage.next_ino rather than left to SQLite,
          -- because this number is published as ino and a caller may key
          -- durable state to it. A bare rowid is max(rowid) + 1, so deleting
          -- the newest entry frees its number for the next one, and a recycled
          -- identity is worse than none: an absent one is known to be
          -- unusable while a recycled one looks correct. POSIX permits reuse;
          -- nothing requires it, so never reusing is a strengthening.
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
          uid INTEGER NOT NULL CHECK (uid >= 0 AND uid <= 4294967295),
          gid INTEGER NOT NULL CHECK (gid >= 0 AND gid <= 4294967295),
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
        CREATE UNIQUE INDEX vfs_entries_path
          ON vfs_entries(path);
        CREATE UNIQUE INDEX vfs_entries_parent_name
          ON vfs_entries(parent_path, name);
        CREATE INDEX vfs_entries_opaque_object
          ON vfs_entries(opaque_object_id) WHERE opaque_object_id IS NOT NULL;
        -- Resolution asks only for links, and only ever by path. A partial
        -- index keeps that query proportional to the number of links rather
        -- than to the size of the namespace.
        CREATE INDEX vfs_entries_symlink
          ON vfs_entries(path) WHERE kind = 'symlink';`;

/**
 * The row-shape guards SQLite enforces rather than JavaScript.
 *
 * Recreated wholesale by the version-2 rebuild, because `ALTER TABLE ...
 * RENAME` does two different things to them. The four attached to the entry
 * table follow it to its temporary name and are dropped with it. The two
 * attached to `vfs_opaque_objects` and `vfs_inline_chunks` survive — but
 * SQLite rewrites their bodies to reference the renamed table, leaving them
 * guarding a table that no longer exists. Dropping all six by name and
 * reinstalling this one definition is what keeps a migrated database enforcing
 * exactly what a fresh one does.
 */
export const ENTRY_TRIGGERS = `
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
          BEGIN SELECT RAISE(ABORT, 'inline chunk has no inline entry'); END;`;

export const DROP_ENTRY_TRIGGERS = `
        DROP TRIGGER IF EXISTS vfs_opaque_entry_insert_guard;
        DROP TRIGGER IF EXISTS vfs_opaque_entry_update_guard;
        DROP TRIGGER IF EXISTS vfs_inline_entry_delete_guard;
        DROP TRIGGER IF EXISTS vfs_inline_entry_update_guard;
        DROP TRIGGER IF EXISTS vfs_opaque_object_delete_guard;
        DROP TRIGGER IF EXISTS vfs_inline_chunk_insert_guard;`;

export const ENTRY_COLUMNS = `
  e.id, e.path, e.parent_path, e.name, e.kind, e.content_class,
  e.opaque_object_id, e.link_target, e.size_bytes, e.mode, e.uid, e.gid, e.created_at_ms,
  e.modified_at_ms, e.revision, e.mutation_version
`;
