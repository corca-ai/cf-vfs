import { R2ContentReader } from "../src/shell/opaque.js";
import { R2OpaqueStore } from "../src/storage/r2.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import type { OpaqueStore } from "../src/vfs/types.js";
import { meterSqlStorage, type SqlMeter } from "./metered-sql.js";

const MIB = 1024 * 1024;

export type RemoteBenchmarkProfile = "quick" | "full";

export interface DurationSummary {
  samples: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export interface SqlCost {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

interface PointCosts {
  statCost: SqlCost & {
    nextCalls: number;
    toArrayCalls: number;
    oneCalls: number;
  };
  overwriteCost: SqlCost;
  populatedStatCost: SqlCost;
  statQueryPlan: string[];
}

/**
 * What one opaque body read cost, measured inside the Durable Object.
 *
 * The local tests prove the shape of the streaming — bounded memory, early
 * cancellation, one GET. These are the numbers that need a real bucket: how
 * long the first byte takes over the network, how long the object holds the
 * DO, and how many R2 operations one read actually performs.
 */
export interface OpaqueReadCost {
  /** From asking for the body to the first chunk arriving. */
  firstByteMs: number;
  /** Wall time inside the DO for the whole read, including the first byte. */
  durationMs: number;
  bytes: number;
  chunks: number;
  /** The largest single chunk, which is the read's memory high-water mark. */
  maxChunkBytes: number;
  r2Gets: number;
  sql: SqlCost;
}

export interface RemoteBenchmarkResult {
  schemaVersion: 3;
  profile: RemoteBenchmarkProfile;
  timing: "caller-observed-rpc";
  startedAt: string;
  completedAt: string;
  databaseSizeBytes: number;
  rpcOverhead: DurationSummary;
  point: {
    stat: DurationSummary;
    overwrite: DurationSummary;
    findPage: DurationSummary;
    warmInitialize: DurationSummary;
    statCost: PointCosts["statCost"];
    overwriteCost: SqlCost;
    populatedStatCost: SqlCost;
    statQueryPlan: string[];
  };
  append: Record<
    "1MiB" | "8MiB",
    {
      duration: DurationSummary;
      maxRowsWritten: number;
    }
  >;
  /**
   * Opaque body reads, when the deployment has a bucket bound.
   *
   * Absent rather than zeroed when it does not: a missing measurement and a
   * measurement of nothing are different things, and a baseline that reported
   * zeros would look like a regression the day a bucket appears.
   */
  opaque?: {
    "1MiB": OpaqueReadCost;
    "8MiB": OpaqueReadCost;
    /** `head -c`: the same body, asked for 16 bytes of it. */
    range16B: OpaqueReadCost;
    /** Stopped after the first chunk, to show the read stops with it. */
    cancelled: OpaqueReadCost;
  };
  subtree: Record<
    "100" | "1000",
    {
      copy: DurationSummary;
      move: DurationSummary;
      remove: DurationSummary;
      statements: {
        copy: number;
        move: number;
        remove: number;
      };
    }
  >;
}

interface ProfileSettings {
  pointSamples: number;
  statIterations: number;
  overwriteIterations: number;
  findIterations: number;
  initializeIterations: number;
  appendSamples: number;
  subtreeSamples: Readonly<Record<"100" | "1000", number>>;
}

const PROFILE_SETTINGS: Readonly<Record<RemoteBenchmarkProfile, ProfileSettings>> = {
  quick: {
    pointSamples: 5,
    statIterations: 1_000,
    overwriteIterations: 30,
    findIterations: 10,
    initializeIterations: 100,
    appendSamples: 3,
    subtreeSamples: { "100": 5, "1000": 3 },
  },
  full: {
    pointSamples: 9,
    statIterations: 5_000,
    overwriteIterations: 100,
    findIterations: 30,
    initializeIterations: 500,
    appendSamples: 7,
    subtreeSamples: { "100": 12, "1000": 7 },
  },
};

export interface RemoteBenchmarkRpc {
  ping(): Promise<void>;
  hasBucket(): Promise<boolean>;
  opaqueRead(sizeBytes: number, mode: "full" | "range" | "cancel"): Promise<OpaqueReadCost>;
  preparePoint(): Promise<PointCosts>;
  statBatch(iterations: number): Promise<number>;
  overwriteBatch(iterations: number): Promise<number>;
  findPageBatch(iterations: number): Promise<number>;
  warmInitializeBatch(iterations: number): Promise<number>;
  prepareAppend(path: string, bytes: number): Promise<void>;
  append(path: string): Promise<void>;
  appendCost(label: "1MiB" | "8MiB", bytes: number): Promise<number>;
  prepareSubtree(label: "100" | "1000", files: number): Promise<void>;
  copySubtree(label: "100" | "1000"): Promise<void>;
  moveSubtree(label: "100" | "1000"): Promise<void>;
  removeSubtree(label: "100" | "1000"): Promise<void>;
  subtreeStatements(
    label: "100" | "1000",
    files: number,
  ): Promise<{ copy: number; move: number; remove: number }>;
  databaseSize(): Promise<number>;
  cleanup(): Promise<void>;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function summarize(durations: readonly number[]): DurationSummary {
  if (durations.length === 0) throw new Error("benchmark produced no samples");
  const sorted = [...durations].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, duration) => sum + duration, 0) / sorted.length;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    samples: sorted.length,
    meanMs: rounded(mean),
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)] ?? 0),
    p95Ms: rounded(sorted[p95Index] ?? 0),
    minMs: rounded(sorted[0] ?? 0),
    maxMs: rounded(sorted.at(-1) ?? 0),
  };
}

function sqlCost(meter: SqlMeter): SqlCost {
  return {
    statements: meter.statements,
    rowsRead: meter.rowsRead,
    rowsWritten: meter.rowsWritten,
  };
}

async function measureRpc(
  samples: number,
  iterations: number,
  operation: () => Promise<unknown>,
): Promise<DurationSummary> {
  await operation();
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    await operation();
    durations.push((performance.now() - started) / iterations);
  }
  return summarize(durations);
}

export class RemoteBenchmarkHarness {
  private readonly storage: DurableObjectStorage;
  private readonly fileSystem: DurableObjectFileSystem;
  private readonly bucket: R2Bucket | undefined;

  constructor(storage: DurableObjectStorage, bucket?: R2Bucket) {
    this.storage = storage;
    this.bucket = bucket;
    this.fileSystem = new DurableObjectFileSystem(storage);
  }

  ping(): void {}

  hasBucket(): boolean {
    return this.bucket !== undefined;
  }

  /**
   * Drains the garbage queue, for the object's alarm handler.
   *
   * Committing an opaque generation schedules one, and a Durable Object that
   * calls `setAlarm` without an `alarm()` handler fails the call outright —
   * which is how the first run of this benchmark discovered it needed one.
   */
  async drainGarbage(): Promise<void> {
    await this.fileSystem.drainGarbage();
  }

  /**
   * Measures one opaque body read against a real bucket.
   *
   * The order under test is the one the design turns on: metadata and the
   * retention lease commit in a short SQL transaction, and the R2 GET happens
   * after. So the SQL cost here is the lease, and everything after the first
   * byte is transfer the DO is relaying rather than storing.
   *
   * `mode` picks what the caller does with the body: read all of it, ask for a
   * range of it, or stop after the first chunk — the three shapes a shell
   * command actually produces.
   */
  async opaqueRead(sizeBytes: number, mode: "full" | "range" | "cancel"): Promise<OpaqueReadCost> {
    const bucket = this.bucket;
    if (bucket === undefined) throw new Error("no R2 bucket is bound");

    let gets = 0;
    const store: OpaqueStore = {
      putIfAbsent: (key, body, metadata) =>
        new R2OpaqueStore(bucket).putIfAbsent(key, body, metadata),
      head: (key) => new R2OpaqueStore(bucket).head(key),
      getStream: (key, range) => {
        gets += 1;
        return new R2OpaqueStore(bucket).getStream(key, range);
      },
      delete: (keys) => new R2OpaqueStore(bucket).delete(keys),
    };

    const path = `/opaque-${sizeBytes}-${mode}`;
    const meter = meterSqlStorage(this.storage);
    const fileSystem = new DurableObjectFileSystem(meter.storage, { opaqueStore: store });
    // A fresh generation per run, so a measurement never reads a body a
    // previous run left warm in some cache.
    await fileSystem.remove(path, { recursive: true }).catch(() => undefined);
    const upload = await fileSystem.beginOpaqueUpload(path);
    await store.putIfAbsent(upload.objectKey, new Uint8Array(sizeBytes).fill(120));
    await fileSystem.commitOpaqueUpload(upload.uploadId);

    gets = 0;
    meter.reset();
    const reader = new R2ContentReader(fileSystem, store);
    const started = Date.now();
    const body = await reader.open(path, mode === "range" ? { offset: 0, length: 16 } : undefined);
    const stream = body.stream.getReader();
    let firstByteMs = 0;
    let bytes = 0;
    let chunks = 0;
    let maxChunkBytes = 0;
    for (;;) {
      const next = await stream.read();
      if (next.done) break;
      if (chunks === 0) firstByteMs = Date.now() - started;
      chunks += 1;
      bytes += next.value.byteLength;
      maxChunkBytes = Math.max(maxChunkBytes, next.value.byteLength);
      if (mode === "cancel") {
        await stream.cancel();
        break;
      }
    }
    const durationMs = Date.now() - started;
    return {
      firstByteMs,
      durationMs,
      bytes,
      chunks,
      maxChunkBytes,
      r2Gets: gets,
      sql: sqlCost(meter),
    };
  }

  async preparePoint(): Promise<PointCosts> {
    const meter = meterSqlStorage(this.storage);
    const measured = new DurableObjectFileSystem(meter.storage);
    await measured.writeFile("/point", "abcdefgh");

    meter.reset();
    measured.stat("/point");
    const statCost = {
      ...sqlCost(meter),
      nextCalls: meter.cursorNextCalls,
      toArrayCalls: meter.cursorToArrayCalls,
      oneCalls: meter.cursorOneCalls,
    };

    meter.reset();
    await measured.writeFile("/point", "abcdefgh");
    const overwriteCost = sqlCost(meter);

    this.fileSystem.mkdir("/search");
    for (let index = 0; index < 1_000; index += 1) {
      await this.fileSystem.writeFile(`/search/file-${index}`, "x");
    }
    meter.reset();
    measured.stat("/point");
    const populatedStatCost = sqlCost(meter);
    const statQueryPlan = this.storage.sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
       SELECT
         e.id, e.path, e.parent_path, e.name, e.kind, e.content_class,
         e.opaque_object_id, e.size_bytes, e.mode, e.created_at_ms,
         e.modified_at_ms, e.revision, e.mutation_version
       FROM vfs_entries e INDEXED BY vfs_entries_path
       WHERE e.path = ?`,
        "/point",
      )
      .toArray()
      .map((row) => row.detail);

    return { statCost, overwriteCost, populatedStatCost, statQueryPlan };
  }

  statBatch(iterations: number): number {
    let revisions = 0;
    for (let index = 0; index < iterations; index += 1) {
      revisions += this.fileSystem.stat("/point").revision;
    }
    return revisions;
  }

  async overwriteBatch(iterations: number): Promise<number> {
    let revision = 0;
    for (let index = 0; index < iterations; index += 1) {
      revision = (await this.fileSystem.writeFile("/point", "abcdefgh")).revision;
    }
    return revision;
  }

  findPageBatch(iterations: number): number {
    let scanned = 0;
    for (let index = 0; index < iterations; index += 1) {
      scanned += this.fileSystem.findPage({
        path: "/search",
        name: "file-?*",
        pathGlob: "/search/file-*",
        limit: 1_000,
      }).scanned;
    }
    return scanned;
  }

  warmInitializeBatch(iterations: number): number {
    for (let index = 0; index < iterations; index += 1) {
      new DurableObjectFileSystem(this.storage);
    }
    return this.storage.sql.databaseSize;
  }

  async prepareAppend(path: string, bytes: number): Promise<void> {
    await this.fileSystem.writeFile(path, new Uint8Array(bytes), {
      createParents: true,
    });
  }

  async append(path: string): Promise<void> {
    await this.fileSystem.appendFile(path, Uint8Array.of(1));
  }

  async appendCost(label: "1MiB" | "8MiB", bytes: number): Promise<number> {
    const meter = meterSqlStorage(this.storage);
    const measured = new DurableObjectFileSystem(meter.storage);
    const path = `/append-cost/${label}`;
    await measured.writeFile(path, new Uint8Array(bytes), { createParents: true });
    meter.reset();
    await measured.appendFile(path, Uint8Array.of(1));
    const rowsWritten = meter.rowsWritten;
    await measured.remove(path);
    return rowsWritten;
  }

  async prepareSubtree(label: "100" | "1000", files: number): Promise<void> {
    const source = `/tree-${label}/source`;
    this.fileSystem.mkdir(source, true);
    for (let index = 0; index < files; index += 1) {
      await this.fileSystem.writeFile(`${source}/file-${index}`, "abcdefgh");
    }
  }

  async copySubtree(label: "100" | "1000"): Promise<void> {
    await this.fileSystem.copy(`/tree-${label}/source`, `/tree-${label}/copy`, { recursive: true });
  }

  async moveSubtree(label: "100" | "1000"): Promise<void> {
    await this.fileSystem.move(`/tree-${label}/copy`, `/tree-${label}/moved`);
  }

  async removeSubtree(label: "100" | "1000"): Promise<void> {
    await this.fileSystem.remove(`/tree-${label}/moved`, { recursive: true });
  }

  async subtreeStatements(
    label: "100" | "1000",
    files: number,
  ): Promise<{ copy: number; move: number; remove: number }> {
    const meter = meterSqlStorage(this.storage);
    const measured = new DurableObjectFileSystem(meter.storage, { chunkBytes: 4 });
    const source = `/tree-cost-${label}/source`;
    const copy = `/tree-cost-${label}/copy`;
    const moved = `/tree-cost-${label}/moved`;
    measured.mkdir(source, true);
    for (let index = 0; index < files; index += 1) {
      await measured.writeFile(`${source}/file-${index}`, "abcdefgh");
    }
    meter.reset();
    await measured.copy(source, copy, { recursive: true });
    const copyStatements = meter.statements;
    meter.reset();
    await measured.move(copy, moved);
    const moveStatements = meter.statements;
    meter.reset();
    await measured.remove(moved, { recursive: true });
    const removeStatements = meter.statements;
    await measured.remove(source, { recursive: true });
    return {
      copy: copyStatements,
      move: moveStatements,
      remove: removeStatements,
    };
  }

  databaseSize(): number {
    return this.storage.sql.databaseSize;
  }

  async cleanup(): Promise<void> {
    await this.storage.deleteAll();
  }
}

async function benchmarkSubtrees(
  stub: RemoteBenchmarkRpc,
  settings: ProfileSettings,
): Promise<RemoteBenchmarkResult["subtree"]> {
  const results = {} as RemoteBenchmarkResult["subtree"];
  for (const [label, files] of [
    ["100", 100],
    ["1000", 1_000],
  ] as const) {
    await stub.prepareSubtree(label, files);
    await stub.copySubtree(label);
    await stub.moveSubtree(label);
    await stub.removeSubtree(label);

    const copyDurations: number[] = [];
    const moveDurations: number[] = [];
    const removeDurations: number[] = [];
    const samples = settings.subtreeSamples[label];
    for (let sample = 0; sample < samples; sample += 1) {
      let started = performance.now();
      await stub.copySubtree(label);
      copyDurations.push(performance.now() - started);
      started = performance.now();
      await stub.moveSubtree(label);
      moveDurations.push(performance.now() - started);
      started = performance.now();
      await stub.removeSubtree(label);
      removeDurations.push(performance.now() - started);
    }
    results[label] = {
      copy: summarize(copyDurations),
      move: summarize(moveDurations),
      remove: summarize(removeDurations),
      statements: await stub.subtreeStatements(label, files),
    };
  }
  return results;
}

async function benchmarkAppend(
  stub: RemoteBenchmarkRpc,
  settings: ProfileSettings,
): Promise<RemoteBenchmarkResult["append"]> {
  const results = {} as RemoteBenchmarkResult["append"];
  for (const [label, bytes] of [
    ["1MiB", MIB - 1],
    ["8MiB", 8 * MIB - 1],
  ] as const) {
    const paths = Array.from(
      { length: settings.appendSamples + 1 },
      (_, index) => `/append/${label}-${index}`,
    );
    for (const path of paths) await stub.prepareAppend(path, bytes);
    await stub.append(paths[0] ?? "");
    const durations: number[] = [];
    for (const path of paths.slice(1)) {
      const started = performance.now();
      await stub.append(path);
      durations.push(performance.now() - started);
    }
    results[label] = {
      duration: summarize(durations),
      maxRowsWritten: await stub.appendCost(label, bytes),
    };
  }
  return results;
}

export async function runRemoteBenchmark(
  stub: RemoteBenchmarkRpc,
  profile: RemoteBenchmarkProfile,
): Promise<RemoteBenchmarkResult> {
  const startedAt = new Date().toISOString();
  const settings = PROFILE_SETTINGS[profile];
  // Omitted rather than zeroed when no bucket is bound: a missing measurement
  // and a measurement of nothing are different things.
  const opaque = (await stub.hasBucket())
    ? {
        "1MiB": await stub.opaqueRead(MIB, "full"),
        "8MiB": await stub.opaqueRead(8 * MIB, "full"),
        range16B: await stub.opaqueRead(8 * MIB, "range"),
        cancelled: await stub.opaqueRead(8 * MIB, "cancel"),
      }
    : undefined;
  const rpcOverhead = await measureRpc(settings.pointSamples, 1, () => stub.ping());
  const pointCosts = await stub.preparePoint();
  const point = {
    stat: await measureRpc(settings.pointSamples, settings.statIterations, () =>
      stub.statBatch(settings.statIterations),
    ),
    overwrite: await measureRpc(settings.pointSamples, settings.overwriteIterations, () =>
      stub.overwriteBatch(settings.overwriteIterations),
    ),
    findPage: await measureRpc(settings.pointSamples, settings.findIterations, () =>
      stub.findPageBatch(settings.findIterations),
    ),
    warmInitialize: await measureRpc(settings.pointSamples, settings.initializeIterations, () =>
      stub.warmInitializeBatch(settings.initializeIterations),
    ),
    ...pointCosts,
  };
  const subtree = await benchmarkSubtrees(stub, settings);
  const append = await benchmarkAppend(stub, settings);
  return {
    schemaVersion: 3,
    ...(opaque === undefined ? {} : { opaque }),
    profile,
    timing: "caller-observed-rpc",
    startedAt,
    completedAt: new Date().toISOString(),
    databaseSizeBytes: await stub.databaseSize(),
    rpcOverhead,
    point,
    append,
    subtree,
  };
}
