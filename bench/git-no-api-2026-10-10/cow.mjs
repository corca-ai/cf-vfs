import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const { NodeSqlFileSystem } = await import(
  new URL("testing/node.js", pathToFileURL(`${resolve(process.argv[2])}/`))
);
const rows = [];
function install(vfs) {
  const db = vfs.storage;
  db.execBatch(`
 DROP TRIGGER vfs_inline_chunk_insert_guard;
 ALTER TABLE vfs_inline_chunks RENAME TO cow_old_chunks;
 CREATE TABLE cow_bodies(id INTEGER PRIMARY KEY,body BLOB NOT NULL);
 CREATE TABLE cow_refs(entry_id INTEGER NOT NULL,chunk_index INTEGER NOT NULL,body_id INTEGER NOT NULL,PRIMARY KEY(entry_id,chunk_index));
 CREATE INDEX cow_refs_body ON cow_refs(body_id);
 INSERT INTO cow_bodies(id,body) SELECT row_number() OVER (ORDER BY entry_id,chunk_index),body FROM cow_old_chunks;
 INSERT INTO cow_refs SELECT entry_id,chunk_index,row_number() OVER (ORDER BY entry_id,chunk_index) FROM cow_old_chunks;
 DROP TABLE cow_old_chunks;
 CREATE VIEW vfs_inline_chunks AS SELECT r.entry_id,r.chunk_index,b.body FROM cow_refs r JOIN cow_bodies b ON b.id=r.body_id;
 CREATE TRIGGER cow_insert INSTEAD OF INSERT ON vfs_inline_chunks BEGIN
 INSERT INTO cow_bodies(body)VALUES(NEW.body);
 INSERT INTO cow_refs VALUES(NEW.entry_id,NEW.chunk_index,last_insert_rowid());
 END;
 `);
  const exec = db.sql.exec.bind(db.sql);
  db.sql.exec = (query, ...args) => {
    if (
      query.includes(
        "INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body)\n       SELECT destination.id",
      )
    )
      query = query
        .replace(
          "INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body)",
          "INSERT INTO cow_refs (entry_id, chunk_index, body_id)",
        )
        .replace("chunk.chunk_index, chunk.body", "chunk.chunk_index, chunk.body_id")
        .replace("FROM vfs_inline_chunks chunk", "FROM cow_refs chunk");
    return exec(query, ...args);
  };
}
for (let pair = -2; pair < 8; pair++)
  for (const version of pairOrder(pair)) {
    const fs = new NodeSqlFileSystem();
    try {
      fs.mkdir("/source");
      for (let n = 0; n < 1000; n++) await fs.writeFile(`/source/f${n}`, `file-${n}-`.repeat(96));
      if (version === "candidate") install(fs);
      const started = performance.now();
      await fs.copy("/source", "/copy", { recursive: true });
      const ms = performance.now() - started;
      for (let n = 0; n < 1000; n++)
        assert.equal(
          await new Response(fs.readFile(`/copy/f${n}`).stream).text(),
          `file-${n}-`.repeat(96),
        );
      const bodyBytes = fs.storage.sql
        .exec(
          version === "candidate"
            ? "SELECT SUM(length(body)) AS bytes FROM cow_bodies"
            : "SELECT SUM(length(body)) AS bytes FROM vfs_inline_chunks",
        )
        .one().bytes;
      let mutationFailure;
      try {
        await fs.writeFile("/source/f0", "changed");
        assert.equal(await new Response(fs.readFile("/source/f0").stream).text(), "changed");
        await fs.appendFile("/source/f0", " appended");
        await fs.writeFile("/source/multi", new Uint8Array(131072));
        assert.equal(
          await new Response(fs.readFile("/copy/f0").stream).text(),
          "file-0-".repeat(96),
        );
      } catch (e) {
        mutationFailure = e.message;
      }
      if (pair >= 0) rows.push({ pair, version, ms, bodyBytes, mutationFailure });
    } finally {
      fs.close();
    }
  }
const a = rows.filter((r) => r.version === "baseline"),
  b = rows.filter((r) => r.version === "candidate");
const summary = {
  before: distribution(a.map((r) => r.ms)),
  after: distribution(b.map((r) => r.ms)),
  ratio: pairedRatio(
    a.map((r) => r.ms),
    b.map((r) => r.ms),
  ),
  beforeBodyBytes: a[0].bodyBytes,
  afterBodyBytes: b[0].bodyBytes,
  mutationFailure: b[0].mutationFailure,
};
await writeFile(process.argv[3], JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary));
