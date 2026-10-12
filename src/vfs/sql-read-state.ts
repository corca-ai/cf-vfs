import type { EntryRow, InlineEntryRow, VfsSqlStorage } from "./sql-model.js";

/** Shared by filesystem owners of one SQL storage, never by separate databases. */
class SqlReadState {
  generation = 0;
  depth = 0;
  stableTraversalDepth = 0;
  private batch: Map<string, InlineEntryRow> | undefined;

  /** One-use metadata, not file bodies or authorization decisions. */
  rememberBatch(entries: Iterable<EntryRow>): void {
    if (this.depth !== 0) return;
    this.batch ??= new Map();
    for (const entry of entries) {
      if (entry.kind !== "file" || entry.contentClass !== "inline") continue;
      if (this.batch.size >= 1000 && !this.batch.has(entry.path)) this.batch.clear();
      this.batch.set(entry.path, entry);
    }
  }

  takeEntry(path: string): InlineEntryRow | undefined {
    if (this.depth !== 0) return undefined;
    const entry = this.batch?.get(path);
    this.batch?.delete(path);
    return entry;
  }

  invalidateBatch(): void {
    this.batch = undefined;
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
