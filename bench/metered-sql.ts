export interface SqlMeter {
  readonly storage: DurableObjectStorage;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
  readonly cursorNextCalls: number;
  readonly cursorToArrayCalls: number;
  readonly cursorOneCalls: number;
  reset(): void;
}

function meteredIterator<T>(
  iterator: IterableIterator<T>,
  sample: () => void,
): IterableIterator<T> {
  return {
    next(...args: [] | [undefined]) {
      const result = iterator.next(...args);
      sample();
      return result;
    },
    return(value?: T) {
      const result = iterator.return?.(value) ?? { done: true as const, value };
      sample();
      return result;
    },
    throw(error?: unknown) {
      if (iterator.throw === undefined) throw error;
      try {
        return iterator.throw(error);
      } finally {
        sample();
      }
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}

function meteredCursor<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
  add: (rowsRead: number, rowsWritten: number) => void,
  observe: (method: "next" | "toArray" | "one") => void,
): SqlStorageCursor<T> {
  let observedRowsRead = 0;
  let observedRowsWritten = 0;
  const sample = () => {
    const rowsRead = cursor.rowsRead;
    const rowsWritten = cursor.rowsWritten;
    add(rowsRead - observedRowsRead, rowsWritten - observedRowsWritten);
    observedRowsRead = rowsRead;
    observedRowsWritten = rowsWritten;
  };
  sample();
  return new Proxy(cursor, {
    get(target, property) {
      if (property === "next")
        return () => {
          observe("next");
          const result = target.next();
          sample();
          return result;
        };
      if (property === "toArray")
        return () => {
          observe("toArray");
          const result = target.toArray();
          sample();
          return result;
        };
      if (property === "one")
        return () => {
          observe("one");
          const result = target.one();
          sample();
          return result;
        };
      if (property === "raw")
        return <U extends SqlStorageValue[]>() => meteredIterator(target.raw<U>(), sample);
      if (property === Symbol.iterator)
        return () => meteredIterator(target[Symbol.iterator](), sample);
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

export function meterSqlStorage(original: DurableObjectStorage): SqlMeter {
  let rowsRead = 0;
  let rowsWritten = 0;
  let statements = 0;
  let cursorNextCalls = 0;
  let cursorToArrayCalls = 0;
  let cursorOneCalls = 0;
  const sql: SqlStorage = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
      statements += 1;
      const cursor = Reflect.apply(original.sql.exec, original.sql, [
        query,
        ...bindings,
      ]) as SqlStorageCursor<T>;
      return meteredCursor(
        cursor,
        (read, written) => {
          rowsRead += read;
          rowsWritten += written;
        },
        (method) => {
          if (method === "next") cursorNextCalls += 1;
          else if (method === "toArray") cursorToArrayCalls += 1;
          else cursorOneCalls += 1;
        },
      );
    },
    get databaseSize() {
      return original.sql.databaseSize;
    },
    Cursor: original.sql.Cursor,
    Statement: original.sql.Statement,
  };
  const storage = new Proxy(original, {
    get(target, property) {
      if (property === "sql") return sql;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    storage,
    get rowsRead() {
      return rowsRead;
    },
    get rowsWritten() {
      return rowsWritten;
    },
    get statements() {
      return statements;
    },
    get cursorNextCalls() {
      return cursorNextCalls;
    },
    get cursorToArrayCalls() {
      return cursorToArrayCalls;
    },
    get cursorOneCalls() {
      return cursorOneCalls;
    },
    reset() {
      rowsRead = 0;
      rowsWritten = 0;
      statements = 0;
      cursorNextCalls = 0;
      cursorToArrayCalls = 0;
      cursorOneCalls = 0;
    },
  };
}
