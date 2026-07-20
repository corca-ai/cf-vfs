export interface SqlMeter {
  readonly storage: DurableObjectStorage;
  readonly rowsRead: number;
  readonly rowsWritten: number;
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
      if (property === "next") return () => {
        const result = target.next();
        sample();
        return result;
      };
      if (property === "toArray") return () => {
        const result = target.toArray();
        sample();
        return result;
      };
      if (property === "one") return () => {
        const result = target.one();
        sample();
        return result;
      };
      if (property === "raw") return <U extends SqlStorageValue[]>() => (
        meteredIterator(target.raw<U>(), sample)
      );
      if (property === Symbol.iterator) return () => (
        meteredIterator(target[Symbol.iterator](), sample)
      );
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

export function meterSqlStorage(original: DurableObjectStorage): SqlMeter {
  let rowsRead = 0;
  let rowsWritten = 0;
  const sql: SqlStorage = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
      const cursor = Reflect.apply(original.sql.exec, original.sql, [query, ...bindings]) as SqlStorageCursor<T>;
      return meteredCursor(cursor, (read, written) => {
        rowsRead += read;
        rowsWritten += written;
      });
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
    get rowsRead() { return rowsRead; },
    get rowsWritten() { return rowsWritten; },
    reset() {
      rowsRead = 0;
      rowsWritten = 0;
    },
  };
}
