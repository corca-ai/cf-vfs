import { VfsError } from "../core/errors.js";
import {
  SqlFileSystem,
  type SqlFileSystemOptions,
  type SqlFileSystemStorage,
  type VfsSqlBinding,
  type VfsSqlCursor,
  type VfsSqlRow,
} from "./sql.js";

// Cloudflare caps a BLOB or complete table row at 2 MB. Leave ample room for
// the composite primary-key columns and SQLite record encoding.
const MAX_SQLITE_INLINE_CHUNK_BYTES = 1024 * 1024;

export type DurableObjectFileSystemOptions = SqlFileSystemOptions;

function adaptStorage(storage: DurableObjectStorage): SqlFileSystemStorage {
  return {
    sql: {
      get databaseSize() {
        return storage.sql.databaseSize;
      },
      exec<Row extends VfsSqlRow>(
        query: string,
        ...bindings: VfsSqlBinding[]
      ): VfsSqlCursor<Row> {
        return storage.sql.exec<Row>(query, ...bindings);
      },
    },
    execBatch(query) {
      storage.sql.exec(query);
    },
    transactionSync(callback) {
      return storage.transactionSync(callback);
    },
    getAlarm() {
      return storage.getAlarm();
    },
    setAlarm(scheduledTime) {
      return storage.setAlarm(scheduledTime);
    },
    deleteAlarm() {
      return storage.deleteAlarm();
    },
  };
}

export class DurableObjectFileSystem extends SqlFileSystem {
  constructor(
    storage: DurableObjectStorage,
    options: DurableObjectFileSystemOptions = {},
  ) {
    if (
      options.chunkBytes !== undefined
      && options.chunkBytes > MAX_SQLITE_INLINE_CHUNK_BYTES
    ) {
      throw new VfsError(
        "EINVAL",
        `chunkBytes cannot exceed ${MAX_SQLITE_INLINE_CHUNK_BYTES} for SQLite storage`,
      );
    }
    super(adaptStorage(storage), options);
  }
}
