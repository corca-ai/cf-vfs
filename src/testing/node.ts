import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import {
  SqlFileSystem,
  type SqlFileSystemOptions,
  type SqlFileSystemStorage,
  type VfsSqlBinding,
  type VfsSqlCursor,
  type VfsSqlRow,
  type VfsSqlStorage,
} from "../vfs/sql.js";

class ArrayCursor<Row extends VfsSqlRow> implements VfsSqlCursor<Row> {
  constructor(private readonly rows: Row[]) {}

  one(): Row {
    if (this.rows.length !== 1) {
      throw new Error(`expected exactly one SQLite row, received ${this.rows.length}`);
    }
    return this.rows[0] as Row;
  }

  toArray(): Row[] {
    return this.rows;
  }
}

function inputValue(value: VfsSqlBinding): SQLInputValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function outputValue(value: SQLOutputValue): SqlStorageValue {
  if (typeof value === "bigint") {
    const converted = Number(value);
    if (!Number.isSafeInteger(converted)) {
      throw new RangeError("SQLite integer exceeds JavaScript's safe integer range");
    }
    return converted;
  }
  if (value instanceof Uint8Array) return value.slice().buffer;
  return value;
}

function outputRow(row: Record<string, SQLOutputValue>): VfsSqlRow {
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, outputValue(value)]));
}

function integerPragma(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = row?.[name];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    if (Number.isSafeInteger(converted)) return converted;
  }
  throw new Error(`PRAGMA ${name} did not return a safe integer`);
}

class NodeSqlStorage implements VfsSqlStorage {
  constructor(
    private readonly database: DatabaseSync,
    private readonly observe: SqlStatementObserver | undefined,
  ) {}

  get databaseSize(): number {
    return integerPragma(this.database, "page_count") * integerPragma(this.database, "page_size");
  }

  exec<Row extends VfsSqlRow>(query: string, ...bindings: VfsSqlBinding[]): VfsSqlCursor<Row> {
    const statement = this.database.prepare(query);
    const rows = statement.all(...bindings.map(inputValue)).map(outputRow) as Row[];
    this.observe?.(query, rows.length);
    return new ArrayCursor(rows);
  }
}

class NodeSqlFileSystemStorage implements SqlFileSystemStorage {
  readonly database = new DatabaseSync(":memory:");
  readonly sql: NodeSqlStorage;
  private alarm: number | null = null;
  private transactionOpen = false;

  constructor(observe: SqlStatementObserver | undefined) {
    this.sql = new NodeSqlStorage(this.database, observe);
  }

  execBatch(query: string): void {
    this.database.exec(query);
  }

  transactionSync<Result>(callback: () => Result): Result {
    if (this.transactionOpen) return callback();
    this.transactionOpen = true;
    this.database.exec("BEGIN");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionOpen = false;
    }
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarm = null;
    return Promise.resolve();
  }

  close(): void {
    this.database.close();
  }
}

/**
 * Observes each executed statement and the rows it returned.
 *
 * Structural performance guards use this to assert statement and row counts
 * instead of wall-clock time, so an added query is a reviewable failure rather
 * than benchmark noise. It exists for tests; production adapters do not have it.
 */
export type SqlStatementObserver = (query: string, rows: number) => void;

export interface NodeSqlFileSystemOptions extends SqlFileSystemOptions {
  readonly onStatement?: SqlStatementObserver;
}

export class NodeSqlFileSystem extends SqlFileSystem {
  private readonly nodeStorage: NodeSqlFileSystemStorage;
  private closed = false;

  constructor(options: NodeSqlFileSystemOptions = {}) {
    const { onStatement, ...fileSystemOptions } = options;
    const storage = new NodeSqlFileSystemStorage(onStatement);
    try {
      super(storage, fileSystemOptions);
    } catch (error) {
      storage.close();
      throw error;
    }
    this.nodeStorage = storage;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.nodeStorage.close();
  }
}
