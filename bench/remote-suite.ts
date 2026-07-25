import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
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

export interface RemoteBenchmarkResult {
  schemaVersion: 2;
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

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.fileSystem = new DurableObjectFileSystem(storage);
  }

  ping(): void {}

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
         e.modified_at_ms, e.revision, p.version AS mutation_version
       FROM vfs_entries e INDEXED BY vfs_entries_path
       CROSS JOIN vfs_path_versions p
       WHERE e.path = ? AND p.path = e.path`,
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
    schemaVersion: 2,
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
