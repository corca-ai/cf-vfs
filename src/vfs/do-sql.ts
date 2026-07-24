import {
  SqlFileSystem,
  type SqlFileSystemOptions,
  type SqlFileSystemStorage,
  type VfsSqlBinding,
  type VfsSqlCursor,
  type VfsSqlRow,
} from "./sql.js";

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
    super(adaptStorage(storage), options);
  }
}
