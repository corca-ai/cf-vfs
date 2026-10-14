import type { EntryRow, InlineEntryRow, VfsSqlStorage } from "./sql-model.js";
import type { ReadFileOptions } from "./types.js";

/** Shared by filesystem owners of one SQL storage, never by separate databases. */
class SqlReadState {
  generation = 0;
  depth = 0;
  stableTraversalDepth = 0;
  /** The transaction owner clears this before entry and when its callback exits. */
  batch: Map<string, InlineEntryRow> | undefined;

  beginBatch(): Map<string, InlineEntryRow> | undefined {
    if (this.depth !== 0) return;
    this.batch ??= new Map();
    return this.batch;
  }

  /** Ignore a query snapshot if a reentrant observer invalidated its batch. */
  rememberBatch(entries: Iterable<EntryRow>, batch: Map<string, InlineEntryRow> | undefined): void {
    if (batch === undefined || batch !== this.batch || this.depth !== 0) return;
    for (const entry of entries) {
      if (entry.kind !== "file" || entry.contentClass !== "inline") continue;
      if (batch.size >= 1000 && !batch.has(entry.path)) batch.clear();
      batch.set(entry.path, entry);
    }
  }

  takeRangeEntry(path: string, range: ReadFileOptions["range"]): InlineEntryRow | undefined {
    if (range === undefined || this.depth !== 0) return undefined;
    const entry = this.batch?.get(path);
    this.batch?.delete(path);
    return entry;
  }
}

const states = new WeakMap<VfsSqlStorage, SqlReadState>();
export function sqlReadState(sql: VfsSqlStorage): SqlReadState {
  let state = states.get(sql);
  if (state === undefined) {
    state = new SqlReadState();
    states.set(sql, state);
  }
  return state;
}
