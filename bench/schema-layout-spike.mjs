import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const ENTRY_COUNT = 100_000;
const POINT_OPERATIONS = 100_000;
const LIST_OPERATIONS = 2_000;
const FEED_OPERATIONS = 2_000;
const FEED_UPDATES = 20_000;
const CHURN_OPERATIONS = 10_000;
const REPEATS = 7;
const INLINE_FILE_COUNT = 512;
const INLINE_READS = 10_240;
const INLINE_OVERWRITES = 5_000;
const METADATA_UPDATES = 5_000;
const METADATA_SCANS = 1_000;

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function pathAt(index) {
  return `/src/file-${String(index).padStart(6, "0")}.ts`;
}

function operationIndices(count, modulus) {
  let state = 0x9e3779b9;
  return Array.from({ length: count }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % modulus;
  });
}

function elapsed(operation) {
  const started = performance.now();
  operation();
  return performance.now() - started;
}

function databaseBytes(database) {
  const pageCount = database.prepare("PRAGMA page_count").get().page_count;
  const pageSize = database.prepare("PRAGMA page_size").get().page_size;
  return pageCount * pageSize;
}

function createDatabase(layout) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;");
  if (layout === "split") {
    database.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        parent_path TEXT NOT NULL,
        name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        modified_at_ms INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX entries_parent_name ON entries(parent_path, name);
      CREATE TABLE path_versions (
        path TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        change_seq INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE INDEX path_changes ON path_versions(change_seq) WHERE change_seq > 0;
    `);
  } else if (layout === "colocated") {
    database.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        parent_path TEXT NOT NULL,
        name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        modified_at_ms INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        mutation_version INTEGER NOT NULL,
        change_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX entries_parent_name ON entries(parent_path, name);
      CREATE INDEX entry_changes ON entries(change_seq) WHERE change_seq > 0;
      CREATE TABLE tombstones (
        path TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        change_seq INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE INDEX tombstone_changes ON tombstones(change_seq) WHERE change_seq > 0;
    `);
  } else {
    database.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        parent_path TEXT NOT NULL,
        name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        modified_at_ms INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        mutation_version INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX entries_parent_name ON entries(parent_path, name);
      CREATE TABLE tombstones (
        path TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE path_changes (
        path TEXT PRIMARY KEY,
        change_seq INTEGER NOT NULL,
        present INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX path_changes_seq ON path_changes(change_seq);
    `);
  }

  const insertEntry = database.prepare(
    layout === "split"
      ? "INSERT INTO entries VALUES (?, ?, '/src', ?, 8192, 420, 0, 1)"
      : layout === "colocated"
        ? "INSERT INTO entries VALUES (?, ?, '/src', ?, 8192, 420, 0, 1, 1, 0)"
        : "INSERT INTO entries VALUES (?, ?, '/src', ?, 8192, 420, 0, 1, 1)",
  );
  const insertVersion =
    layout === "split" ? database.prepare("INSERT INTO path_versions VALUES (?, 1, 0)") : undefined;
  database.exec("BEGIN");
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const path = pathAt(index);
    const name = path.slice("/src/".length);
    insertEntry.run(index + 1, path, name);
    insertVersion?.run(path);
  }
  database.exec("COMMIT; PRAGMA optimize;");
  return database;
}

function prepareWorkload(database, layout) {
  if (layout === "split") {
    return {
      stat: database.prepare(`
        SELECT e.id, e.size_bytes, e.mode, e.modified_at_ms, e.revision, v.version
        FROM entries e INDEXED BY sqlite_autoindex_entries_1
        CROSS JOIN path_versions v
        WHERE e.path = ? AND v.path = e.path
      `),
      list: database.prepare(`
        SELECT e.path, e.size_bytes, e.mode, e.revision, v.version
        FROM entries e INDEXED BY entries_parent_name
        CROSS JOIN path_versions v
        WHERE e.parent_path = '/src' AND e.name > ? AND v.path = e.path
        ORDER BY e.name LIMIT 100
      `),
      feed: database.prepare(`
        SELECT v.path, (e.path IS NOT NULL) AS present, v.change_seq, e.size_bytes, e.mode
        FROM path_versions v INDEXED BY path_changes
        LEFT JOIN entries e INDEXED BY sqlite_autoindex_entries_1 ON e.path = v.path
        WHERE v.change_seq > 0 AND v.change_seq > ?
        ORDER BY v.change_seq, v.path LIMIT 100
      `),
      update: database.prepare(`
        UPDATE entries SET modified_at_ms = modified_at_ms + 1, revision = revision + 1
        WHERE path = ?
      `),
      bump: database.prepare(
        "UPDATE path_versions SET version = version + 1 WHERE path = ? RETURNING version",
      ),
      updateWithFeed: database.prepare(`
        UPDATE path_versions SET version = version + 1, change_seq = ?
        WHERE path = ? RETURNING version
      `),
      remove: database.prepare("DELETE FROM entries WHERE path = ?"),
      recreate: database.prepare("INSERT INTO entries VALUES (?, ?, '/src', ?, 8192, 420, 0, 1)"),
    };
  }
  const colocated = {
    stat: database.prepare(`
      SELECT id, size_bytes, mode, modified_at_ms, revision, mutation_version AS version
      FROM entries INDEXED BY sqlite_autoindex_entries_1 WHERE path = ?
    `),
    list: database.prepare(`
      SELECT path, size_bytes, mode, revision, mutation_version AS version
      FROM entries INDEXED BY entries_parent_name
      WHERE parent_path = '/src' AND name > ? ORDER BY name LIMIT 100
    `),
    update: database.prepare(`
      UPDATE entries SET modified_at_ms = modified_at_ms + 1, revision = revision + 1,
        mutation_version = mutation_version + 1
      WHERE path = ? RETURNING mutation_version
    `),
    updateEntryWithFeed:
      layout === "colocated"
        ? database.prepare(`
            UPDATE entries SET modified_at_ms = modified_at_ms + 1, revision = revision + 1,
              mutation_version = mutation_version + 1, change_seq = ?
            WHERE path = ? RETURNING mutation_version
          `)
        : database.prepare(`
            UPDATE entries SET modified_at_ms = modified_at_ms + 1, revision = revision + 1,
              mutation_version = mutation_version + 1
            WHERE path = ? RETURNING mutation_version
          `),
    publishChange:
      layout === "separated"
        ? database.prepare(`
            INSERT INTO path_changes VALUES (?, ?, 1)
            ON CONFLICT(path) DO UPDATE SET change_seq = excluded.change_seq, present = 1
          `)
        : undefined,
    remove: database.prepare("DELETE FROM entries WHERE path = ? RETURNING mutation_version"),
    tombstone: database.prepare(
      layout === "colocated"
        ? "INSERT INTO tombstones VALUES (?, ?, 0)"
        : "INSERT INTO tombstones VALUES (?, ?)",
    ),
    recreate: database.prepare(
      layout === "colocated"
        ? `INSERT INTO entries
           SELECT ?, ?, '/src', ?, 8192, 420, 0, 1, version + 1, 0
           FROM tombstones WHERE path = ?`
        : `INSERT INTO entries
           SELECT ?, ?, '/src', ?, 8192, 420, 0, 1, version + 1
           FROM tombstones WHERE path = ?`,
    ),
    clearTombstone: database.prepare("DELETE FROM tombstones WHERE path = ?"),
  };
  return {
    ...colocated,
    feed:
      layout === "colocated"
        ? database.prepare(`
            SELECT path, present, change_seq FROM (
              SELECT path, 1 AS present, change_seq
              FROM entries INDEXED BY entry_changes WHERE change_seq > 0 AND change_seq > ?
              UNION ALL
              SELECT path, 0 AS present, change_seq
              FROM tombstones INDEXED BY tombstone_changes
              WHERE change_seq > 0 AND change_seq > ?
            ) ORDER BY change_seq, path LIMIT 100
          `)
        : database.prepare(`
            SELECT path, present, change_seq FROM path_changes INDEXED BY path_changes_seq
            WHERE change_seq > ? ORDER BY change_seq, path LIMIT 100
          `),
  };
}

function measureLayout(layout) {
  const database = createDatabase(layout);
  const stampChange = database.prepare(
    layout === "split"
      ? "UPDATE path_versions SET change_seq = ? WHERE path = ?"
      : layout === "colocated"
        ? "UPDATE entries SET change_seq = ? WHERE path = ?"
        : "INSERT INTO path_changes VALUES (?, ?, 1)",
  );
  database.exec("BEGIN");
  for (let index = 0; index < 20_000; index += 1) {
    if (layout === "separated") stampChange.run(pathAt(index * 5), index + 1);
    else stampChange.run(index + 1, pathAt(index * 5));
  }
  database.exec("COMMIT; PRAGMA optimize;");
  const statements = prepareWorkload(database, layout);
  const points = operationIndices(POINT_OPERATIONS, ENTRY_COUNT);
  const lists = operationIndices(LIST_OPERATIONS, ENTRY_COUNT - 101);
  const churn = operationIndices(CHURN_OPERATIONS, ENTRY_COUNT);
  let checksum = 0;

  const statMs = elapsed(() => {
    for (const index of points) checksum += statements.stat.get(pathAt(index)).version;
  });
  const listMs = elapsed(() => {
    for (const index of lists) {
      const rows = statements.list.all(`file-${String(index).padStart(6, "0")}.ts`);
      checksum += rows.length;
    }
  });
  const feedMs = elapsed(() => {
    for (let operation = 0; operation < FEED_OPERATIONS; operation += 1) {
      const cursor = (operation * 97) % 19_900;
      const rows =
        layout !== "colocated" ? statements.feed.all(cursor) : statements.feed.all(cursor, cursor);
      checksum += rows.length;
    }
  });
  const updateMs = elapsed(() => {
    database.exec("BEGIN");
    for (const index of points) {
      const path = pathAt(index);
      if (layout === "split") {
        statements.update.run(path);
        checksum += statements.bump.get(path).version;
      } else {
        checksum += statements.update.get(path).mutation_version;
      }
    }
    database.exec("COMMIT");
  });
  const updateWithFeedMs = elapsed(() => {
    database.exec("BEGIN");
    for (let operation = 0; operation < FEED_UPDATES; operation += 1) {
      const path = pathAt(points[operation]);
      const sequence = 20_001 + operation;
      if (layout === "split") {
        statements.update.run(path);
        checksum += statements.updateWithFeed.get(sequence, path).version;
      } else if (layout === "colocated") {
        checksum += statements.updateEntryWithFeed.get(sequence, path).mutation_version;
      } else {
        checksum += statements.updateEntryWithFeed.get(path).mutation_version;
        statements.publishChange.run(path, sequence);
      }
    }
    database.exec("COMMIT");
  });
  const churnMs = elapsed(() => {
    database.exec("BEGIN");
    for (const index of churn) {
      const path = pathAt(index);
      const name = path.slice("/src/".length);
      if (layout === "split") {
        statements.remove.run(path);
        statements.bump.get(path);
        statements.recreate.run(index + 1, path, name);
        checksum += statements.bump.get(path).version;
      } else {
        const version = statements.remove.get(path).mutation_version;
        statements.tombstone.run(path, version + 1);
        statements.recreate.run(index + 1, path, name, path);
        statements.clearTombstone.run(path);
        checksum += version;
      }
    }
    database.exec("COMMIT");
  });

  const liveEntries = database.prepare("SELECT COUNT(*) AS count FROM entries").get().count;
  if (liveEntries !== ENTRY_COUNT || checksum === 0)
    throw new Error(`${layout} verification failed`);
  const result = {
    databaseBytes: databaseBytes(database),
    statMs,
    listMs,
    feedMs,
    updateMs,
    updateWithFeedMs,
    churnMs,
    checksum,
  };
  database.close();
  return result;
}

function measureInlineLayout(threshold) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      mode INTEGER NOT NULL,
      modified_at_ms INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      body BLOB
    );
    CREATE TABLE chunks (
      entry_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      body BLOB NOT NULL,
      PRIMARY KEY (entry_id, chunk_index)
    ) WITHOUT ROWID;
  `);
  const sizes = Array.from(
    { length: INLINE_FILE_COUNT },
    (_value, index) => 8_192 + ((index * 7_919) % 4_097),
  );
  const bodies = sizes.map((size, index) => new Uint8Array(size).fill(index & 0xff));
  const replacementBodies = sizes.map((size, index) =>
    new Uint8Array(size).fill((index + 1) & 0xff),
  );
  const insertEntry = database.prepare("INSERT INTO entries VALUES (?, ?, ?, 420, 0, 1, ?)");
  const insertChunk = database.prepare("INSERT INTO chunks VALUES (?, 0, ?)");
  database.exec("BEGIN");
  for (let index = 0; index < INLINE_FILE_COUNT; index += 1) {
    const embedded = sizes[index] <= threshold;
    insertEntry.run(index + 1, pathAt(index), sizes[index], embedded ? bodies[index] : null);
    if (!embedded) insertChunk.run(index + 1, bodies[index]);
  }
  database.exec("COMMIT; PRAGMA optimize;");

  const readEntry = database.prepare("SELECT id, size_bytes, body FROM entries WHERE path = ?");
  const readChunk = database.prepare("SELECT body FROM chunks WHERE entry_id = ?");
  const overwriteEmbedded = database.prepare(`
    UPDATE entries SET body = ?, modified_at_ms = modified_at_ms + 1, revision = revision + 1
    WHERE path = ?
  `);
  const overwriteSplitEntry = database.prepare(`
    UPDATE entries SET modified_at_ms = modified_at_ms + 1, revision = revision + 1
    WHERE path = ?
  `);
  const overwriteChunk = database.prepare("UPDATE chunks SET body = ? WHERE entry_id = ?");
  const updateMetadata = database.prepare(`
    UPDATE entries SET mode = CASE mode WHEN 420 THEN 384 ELSE 420 END WHERE path = ?
  `);
  const scanMetadata = database.prepare(
    "SELECT path, size_bytes, mode, modified_at_ms, revision FROM entries ORDER BY path",
  );
  const reads = operationIndices(INLINE_READS, INLINE_FILE_COUNT);
  const overwrites = operationIndices(INLINE_OVERWRITES, INLINE_FILE_COUNT);
  const metadata = operationIndices(METADATA_UPDATES, INLINE_FILE_COUNT);
  let checksum = 0;
  const readMs = elapsed(() => {
    for (const index of reads) {
      const row = readEntry.get(pathAt(index));
      const body = row.body ?? readChunk.get(row.id).body;
      checksum += body.byteLength;
    }
  });
  const overwriteMs = elapsed(() => {
    database.exec("BEGIN");
    for (const index of overwrites) {
      if (sizes[index] <= threshold) {
        overwriteEmbedded.run(replacementBodies[index], pathAt(index));
      } else {
        overwriteSplitEntry.run(pathAt(index));
        overwriteChunk.run(replacementBodies[index], index + 1);
      }
    }
    database.exec("COMMIT");
  });
  const metadataMs = elapsed(() => {
    database.exec("BEGIN");
    for (const index of metadata) updateMetadata.run(pathAt(index));
    database.exec("COMMIT");
  });
  const scanMs = elapsed(() => {
    for (let operation = 0; operation < METADATA_SCANS; operation += 1) {
      checksum += scanMetadata.all().length;
    }
  });
  const chunkRows = database.prepare("SELECT COUNT(*) AS count FROM chunks").get().count;
  const expectedChunks = sizes.filter((size) => size > threshold).length;
  if (chunkRows !== expectedChunks || checksum === 0) {
    throw new Error(`inline threshold ${threshold} verification failed`);
  }
  const result = {
    databaseBytes: databaseBytes(database),
    chunkRows,
    readMs,
    overwriteMs,
    metadataMs,
    scanMs,
    checksum,
  };
  database.close();
  return result;
}

const samples = { split: [], colocated: [], separated: [] };
for (let repeat = 0; repeat < REPEATS; repeat += 1) {
  const layouts =
    repeat % 2 === 0 ? ["split", "colocated", "separated"] : ["separated", "colocated", "split"];
  for (const layout of layouts) samples[layout].push(measureLayout(layout));
}

const tokenResult = Object.fromEntries(
  Object.entries(samples).map(([layout, measurements]) => [
    layout,
    Object.fromEntries(
      Object.keys(measurements[0]).map((metric) => [
        metric,
        median(measurements.map((measurement) => measurement[metric])),
      ]),
    ),
  ]),
);
const inlineSamples = { 0: [], 4096: [], 16384: [] };
for (let repeat = 0; repeat < REPEATS; repeat += 1) {
  const thresholds = repeat % 2 === 0 ? [0, 4096, 16384] : [16384, 4096, 0];
  for (const threshold of thresholds) inlineSamples[threshold].push(measureInlineLayout(threshold));
}
const inlineResult = Object.fromEntries(
  Object.entries(inlineSamples).map(([threshold, measurements]) => [
    threshold,
    Object.fromEntries(
      Object.keys(measurements[0]).map((metric) => [
        metric,
        median(measurements.map((measurement) => measurement[metric])),
      ]),
    ),
  ]),
);
console.log(
  JSON.stringify(
    {
      tokenLayout: {
        workload: {
          entries: ENTRY_COUNT,
          pointOperations: POINT_OPERATIONS,
          listOperations: LIST_OPERATIONS,
          listPageSize: 100,
          feedOperations: FEED_OPERATIONS,
          changedPaths: 20_000,
          feedUpdates: FEED_UPDATES,
          churnOperations: CHURN_OPERATIONS,
          repeats: REPEATS,
        },
        result: tokenResult,
      },
      inlineLayout: {
        workload: {
          files: INLINE_FILE_COUNT,
          sizeBytes: "8192..12288",
          reads: INLINE_READS,
          overwrites: INLINE_OVERWRITES,
          metadataUpdates: METADATA_UPDATES,
          metadataScans: METADATA_SCANS,
          repeats: REPEATS,
        },
        result: inlineResult,
      },
    },
    null,
    2,
  ),
);
