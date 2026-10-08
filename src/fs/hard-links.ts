import type { SqlHandlePort } from "../vfs/handle-port.js";

/** Installed only in a database which opts into hard links. Equality guards
 * terminate propagation even when SQLite recursive_triggers is enabled. */
export function installHardLinkTriggers(port: SqlHandlePort): void {
  const columns = [
    "kind",
    "content_class",
    "opaque_object_id",
    "link_target",
    "size_bytes",
    "mode",
    "uid",
    "gid",
    "created_at_ms",
    "modified_at_ms",
    "changed_at_ms",
    "revision",
    "mutation_version",
    "body_digest",
    "body_digest_revision",
  ];
  const metadata = columns.filter(
    (column) =>
      column !== "revision" &&
      column !== "mutation_version" &&
      column !== "body_digest" &&
      column !== "body_digest_revision",
  );
  const watched = columns.filter(
    (column) => column !== "body_digest" && column !== "body_digest_revision",
  );
  port.batch(`
    CREATE TRIGGER IF NOT EXISTS vfs_hard_metadata AFTER UPDATE OF ${watched.join(", ")} ON vfs_entries
    WHEN NEW.link_identity IS NOT NULL AND NEW.mirroring = 0 BEGIN
      UPDATE vfs_entries SET mirroring = 1, ${metadata.map((column) => `${column} = NEW.${column}`).join(", ")},
        body_digest = NULL, body_digest_revision = NULL, revision = revision + 1, mutation_version = mutation_version + 1
      WHERE link_identity = NEW.link_identity AND id <> NEW.id;
      UPDATE vfs_entries SET mirroring = 0 WHERE link_identity = NEW.link_identity AND mirroring <> 0;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_new_name AFTER INSERT ON vfs_entries WHEN NEW.link_identity IS NOT NULL BEGIN
      DELETE FROM vfs_inline_chunks WHERE entry_id IN (SELECT id FROM vfs_entries WHERE link_identity = NEW.link_identity AND id <> NEW.id);
      UPDATE vfs_entries SET link_count = (SELECT COUNT(*) FROM vfs_entries WHERE link_identity = NEW.link_identity)
      WHERE link_identity = NEW.link_identity;
      UPDATE vfs_entries SET mirroring = 1, ${metadata.map((column) => `${column} = NEW.${column}`).join(", ")},
        body_digest = NULL, body_digest_revision = NULL, revision = revision + 1, mutation_version = mutation_version + 1
      WHERE link_identity = NEW.link_identity AND id <> NEW.id;
      UPDATE vfs_entries SET mirroring = 0 WHERE link_identity = NEW.link_identity AND mirroring <> 0;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_chunk_insert AFTER INSERT ON vfs_inline_chunks BEGIN
      INSERT INTO vfs_inline_chunks(entry_id, chunk_index, body)
      SELECT alias.id, NEW.chunk_index, NEW.body FROM vfs_entries source JOIN vfs_entries alias
      ON alias.link_identity = source.link_identity AND alias.id <> source.id
      WHERE source.id = NEW.entry_id AND source.link_identity IS NOT NULL AND source.unlinking = 0
      ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_chunk_update AFTER UPDATE OF body ON vfs_inline_chunks BEGIN
      INSERT INTO vfs_inline_chunks(entry_id, chunk_index, body)
      SELECT alias.id, NEW.chunk_index, NEW.body FROM vfs_entries source JOIN vfs_entries alias
      ON alias.link_identity = source.link_identity AND alias.id <> source.id
      WHERE source.id = NEW.entry_id AND source.link_identity IS NOT NULL AND source.unlinking = 0
      ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_chunk_delete AFTER DELETE ON vfs_inline_chunks BEGIN
      DELETE FROM vfs_inline_chunks WHERE chunk_index = OLD.chunk_index AND entry_id IN (
        SELECT alias.id FROM vfs_entries source JOIN vfs_entries alias ON alias.link_identity = source.link_identity
        WHERE source.id = OLD.entry_id AND source.unlinking = 0 AND alias.id <> source.id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_unlink AFTER DELETE ON vfs_entries WHEN OLD.link_identity IS NOT NULL BEGIN
      UPDATE vfs_entries SET link_count = (SELECT COUNT(*) FROM vfs_entries WHERE link_identity = OLD.link_identity)
      WHERE link_identity = OLD.link_identity;
    END;
  `);
}
