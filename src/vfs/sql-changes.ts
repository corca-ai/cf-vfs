import type { VfsSqlStorage } from "./sql-model.js";

/** Per-storage state every filesystem over the same storage shares. */
export interface TraversalState {
  generation: number;
  depth: number;
  stableTraversalDepth: number;
  /** Statements that may have changed the storage, across every filesystem over it. */
  changes: number;
}
const TRAVERSAL_STATES = new WeakMap<VfsSqlStorage, TraversalState>();
export function traversalState(sql: VfsSqlStorage): TraversalState {
  let state = TRAVERSAL_STATES.get(sql);
  if (state === undefined) {
    state = { generation: 0, depth: 0, stableTraversalDepth: 0, changes: 0 };
    TRAVERSAL_STATES.set(sql, state);
  }
  return state;
}

const WRITES = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu;

/** A plain `SELECT`, or a `WITH` that only feeds one, cannot change anything. */
function reads(query: string): boolean {
  const start = query.trimStart().slice(0, 6).toUpperCase();
  return start === "SELECT" || (start.startsWith("WITH") && !WRITES.test(query));
}

/** The storage's statements, counting each that may change it. */
export function countingChanges(sql: VfsSqlStorage, state: { changes: number }): VfsSqlStorage {
  return {
    get databaseSize() {
      return sql.databaseSize;
    },
    exec(query, ...bindings) {
      if (!reads(query)) state.changes += 1;
      return sql.exec(query, ...bindings);
    },
  };
}
