import { VfsError } from "../src/core/errors.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { median, rowKey } from "./benchmark-protocol.js";

export const RESULT_PATH = "/benchmarks/latest.json";
const HISTORY_PATH = "/benchmarks/trends.json";
const JOB_PATH = "/benchmarks/job.json";
const RUN_PATH = "/benchmarks/run.json";
export const BENCHMARK_TTL_MS = 10 * 60 * 1000;
const RUN_LEASE_MS = 5 * 60 * 1000;
export const MAX_RUNS_PER_COMMIT = 12;

export interface BenchmarkRow {
  group: "files" | "git" | "git-shell" | "coding-small" | "coding-mixed" | "git-recovery";
  operation: string;
  files: number;
  cache: boolean;
  iterations: number;
  samplesMs: number[];
  referenceMs?: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface PublicBenchmarkResult {
  version: 1 | 2;
  protocol?: BenchmarkProtocol;
  diagnostics?: BenchmarkDiagnostics[];
  commitHash?: string;
  deploymentId?: string;
  buildId?: string;
  runId: string;
  completedAt: string;
  colo: string | null;
  engine: string;
  measurement: string;
  rows: BenchmarkRow[];
  verified: number;
}

export interface BenchmarkProtocol {
  id: string;
  referenceCommit: string;
  referenceHash: string;
  pairsPerRun: number;
  warmupPairs: number;
  credentials: string;
}

export interface BenchmarkDiagnostics {
  pair: number;
  group: number;
  order: string[];
  runnerColo: string | null;
  referencePingMs: number[];
  candidatePingMs: number[];
}

export interface BenchmarkJob {
  orderOffset?: number;
  diagnostics?: BenchmarkDiagnostics[];
  commitHash?: string;
  deploymentId?: string;
  buildId?: string;
  runId: string;
  nextIndex: number;
  rows: BenchmarkRow[];
  verified: number;
  colo: string | null;
}

interface RunRecord {
  id: string;
  startedAt: number;
  leaseUntil: number;
  status: "running" | "failed" | "completed";
  error?: string;
}

export interface BenchmarkObservation {
  runId: string;
  completedAt: string;
  buildId?: string;
  deploymentId?: string;
  rows: BenchmarkRow[];
}

export interface BenchmarkHistoryPoint {
  protocol?: BenchmarkProtocol;
  runs?: BenchmarkObservation[];
  totalRuns?: number;
  engine?: string;
  measurement?: string;
  commitHash?: string;
  buildId?: string;
  deploymentId?: string;
  completedAt: string;
  rows: Array<
    Pick<BenchmarkRow, "group" | "operation" | "files" | "cache" | "iterations" | "medianMs">
  >;
}

function historyKey(point: BenchmarkHistoryPoint): string | undefined {
  if (point.commitHash) return `commit:${point.commitHash}`;
  if (point.buildId) return `build:${point.buildId}`;
  if (point.deploymentId) return `deployment:${point.deploymentId}`;
  return undefined;
}

function historyPoint(result: PublicBenchmarkResult): BenchmarkHistoryPoint {
  return {
    ...(result.protocol === undefined
      ? {}
      : {
          protocol: result.protocol,
          totalRuns: 1,
          runs: [
            {
              runId: result.runId,
              completedAt: result.completedAt,
              ...(result.buildId === undefined ? {} : { buildId: result.buildId }),
              ...(result.deploymentId === undefined ? {} : { deploymentId: result.deploymentId }),
              rows: result.rows,
            },
          ],
        }),
    engine: result.engine,
    measurement: result.measurement,
    ...(result.commitHash === undefined ? {} : { commitHash: result.commitHash }),
    ...(result.buildId === undefined ? {} : { buildId: result.buildId }),
    ...(result.deploymentId === undefined ? {} : { deploymentId: result.deploymentId }),
    completedAt: result.completedAt,
    rows: result.rows.map(({ group, operation, files, cache, iterations, medianMs }) => ({
      group,
      operation,
      files,
      cache,
      iterations,
      medianMs,
    })),
  };
}

function accumulate(
  previous: BenchmarkHistoryPoint,
  point: BenchmarkHistoryPoint,
): BenchmarkHistoryPoint {
  if (
    !point.protocol ||
    !point.runs ||
    previous.protocol?.id !== point.protocol.id ||
    !previous.runs
  )
    return point;
  if (
    previous.buildId !== point.buildId ||
    previous.engine !== point.engine ||
    previous.measurement !== point.measurement
  )
    throw new Error(
      "Cannot merge different implementations or measurement protocols under one commit",
    );
  const incoming = point.runs[0];
  if (!incoming) throw new Error("Missing benchmark observation");
  if (previous.runs.some((run) => run.runId === incoming.runId)) return previous;
  const expected = previous.rows.map(rowKey).sort();
  const actual = incoming.rows.map(rowKey).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Benchmark cohort changed");
  const runs = [...previous.runs, incoming].slice(-MAX_RUNS_PER_COMMIT);
  return {
    ...point,
    runs,
    totalRuns: (previous.totalRuns ?? previous.runs.length) + 1,
    rows: point.rows.map((row) => ({
      ...row,
      medianMs: median(
        runs.flatMap((run) => {
          const match = run.rows.find((r) => rowKey(r) === rowKey(row));
          if (!match) throw new Error("Incomplete benchmark observation");
          return match.samplesMs;
        }),
      ),
    })),
  };
}

function validatePairedResult(result: PublicBenchmarkResult) {
  if (!result.protocol) return;
  const seen = new Set<string>();
  for (const row of result.rows) {
    const key = rowKey(row);
    if (seen.has(key)) throw new Error("Duplicate benchmark workload");
    seen.add(key);
    if (
      row.samplesMs.length !== result.protocol.pairsPerRun ||
      row.referenceMs?.length !== result.protocol.pairsPerRun ||
      [...row.samplesMs, ...row.referenceMs].some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error("Invalid paired benchmark samples");
  }
  if (!result.rows.length) throw new Error("Empty paired benchmark result");
}

/** One point per commit; repeated run IDs are idempotent and valid new runs accumulate. */
function updateHistory(history: BenchmarkHistoryPoint[], point: BenchmarkHistoryPoint) {
  const key = historyKey(point);
  if (key === undefined) return history;
  // A new commit annotation may identify a previously unlabelled build.
  const index = history.findIndex(
    (saved) =>
      historyKey(saved) === key ||
      (!saved.commitHash && point.buildId !== undefined && saved.buildId === point.buildId),
  );
  const next = [...history];
  if (index < 0) next.push(point);
  else {
    const previous = next[index];
    if (!previous) throw new Error("Missing history point");
    next[index] = accumulate(previous, point);
  }
  return next.slice(-10);
}

export interface BenchmarkSnapshot {
  status: "empty" | "ready" | "running" | "failed";
  result: PublicBenchmarkResult | null;
  history: BenchmarkHistoryPoint[];
  modifiedAt: number | null;
  nextRunAt: number | null;
  error: string | null;
}

/** Shared result and lease both survive owner eviction in the VFS. */
export class BenchmarkStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: VirtualFileSystem,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdir("/benchmarks", true);
  }

  private async read<T>(path: string): Promise<{ value: T; modifiedAt: number } | null> {
    try {
      const { stat, stream } = this.fs.readFile(path);
      return {
        value: JSON.parse(await new Response(stream).text()),
        modifiedAt: stat.modifiedAtMs,
      };
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private observationPath(point: BenchmarkHistoryPoint) {
    const key = historyKey(point);
    if (!key) throw new Error("Missing observation identity");
    return `/benchmarks/observations/${encodeURIComponent(key)}.json`;
  }

  private historyWrites(points: BenchmarkHistoryPoint[]) {
    return [
      {
        path: HISTORY_PATH,
        body: JSON.stringify(points.map(({ runs: _runs, ...point }) => point)),
      },
      ...points.flatMap((point) =>
        point.runs ? [{ path: this.observationPath(point), body: JSON.stringify(point.runs) }] : [],
      ),
    ];
  }

  private async history(latest: PublicBenchmarkResult | null): Promise<BenchmarkHistoryPoint[]> {
    const saved = await this.read<BenchmarkHistoryPoint[]>(HISTORY_PATH);
    let history = saved?.value ?? [];
    for (const point of history) {
      if (point.protocol && !point.runs) {
        const observations = await this.read<BenchmarkObservation[]>(this.observationPath(point));
        if (!observations) throw new Error("Missing retained benchmark observations");
        point.runs = observations.value;
      }
    }
    if (saved === null) {
      // Older deployments retained up to twenty full runs. Reuse only known
      // build/deployment identities; never invent commit hashes for old data.
      let entries: ReturnType<VirtualFileSystem["list"]>;
      try {
        entries = this.fs.list("/benchmarks/history");
      } catch (error) {
        if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
        entries = [];
      }
      for (const entry of entries.sort((a, b) => a.modifiedAtMs - b.modifiedAtMs)) {
        const result = await this.read<PublicBenchmarkResult>(entry.path);
        if (result !== null) history = updateHistory(history, historyPoint(result.value));
      }
    }
    const next = latest === null ? history : updateHistory(history, historyPoint(latest));
    if (saved === null && next.length > 0) {
      this.fs.mkdir("/benchmarks/observations", true);
      await this.fs.writeFiles(this.historyWrites(next));
    }
    return next;
  }

  private async snapshot(includeHistory = true): Promise<BenchmarkSnapshot> {
    const saved = await this.read<PublicBenchmarkResult>(RESULT_PATH);
    const run = (await this.read<RunRecord>(RUN_PATH))?.value;
    const running = run?.status === "running" && run.leaseUntil > this.now();
    const failed = run?.status === "failed" || (run?.status === "running" && !running);
    const resultNext = saved === null ? null : saved.modifiedAt + BENCHMARK_TTL_MS;
    return {
      status: running ? "running" : failed ? "failed" : saved === null ? "empty" : "ready",
      result: saved?.value ?? null,
      history: includeHistory ? await this.history(saved?.value ?? null) : [],
      modifiedAt: saved?.modifiedAt ?? null,
      nextRunAt: resultNext,
      error: failed
        ? (run?.error ?? "The previous run was interrupted. Please request it again.")
        : null,
    };
  }

  get(includeHistory = true): Promise<BenchmarkSnapshot> {
    return this.serial(() => this.snapshot(includeHistory));
  }

  claim(force = false): Promise<{ runId: string | null; snapshot: BenchmarkSnapshot }> {
    return this.serial(async () => {
      const snapshot = await this.snapshot();
      if (snapshot.status === "running" || (!force && (snapshot.nextRunAt ?? 0) > this.now())) {
        return { runId: null, snapshot };
      }
      const record: RunRecord = {
        id: crypto.randomUUID(),
        startedAt: this.now(),
        leaseUntil: this.now() + RUN_LEASE_MS,
        status: "running",
      };
      await this.fs.writeFile(RUN_PATH, JSON.stringify(record));
      return { runId: record.id, snapshot: await this.snapshot() };
    });
  }

  job(): Promise<BenchmarkJob | null> {
    return this.serial(async () => (await this.read<BenchmarkJob>(JOB_PATH))?.value ?? null);
  }

  checkpoint(job: BenchmarkJob): Promise<void> {
    return this.serial(async () => {
      const run = (await this.read<RunRecord>(RUN_PATH))?.value;
      if (run?.id !== job.runId || run.status !== "running" || run.leaseUntil <= this.now()) {
        throw new Error("Benchmark run is no longer active");
      }
      await this.fs.writeFiles([
        { path: JOB_PATH, body: JSON.stringify(job) },
        { path: RUN_PATH, body: JSON.stringify({ ...run, leaseUntil: this.now() + RUN_LEASE_MS }) },
      ]);
    });
  }

  assertActive(runId: string): Promise<void> {
    return this.serial(async () => {
      const run = (await this.read<RunRecord>(RUN_PATH))?.value;
      if (run?.id !== runId || run.status !== "running" || run.leaseUntil <= this.now()) {
        throw new Error("Benchmark run is no longer active");
      }
    });
  }

  complete(result: PublicBenchmarkResult): Promise<BenchmarkSnapshot> {
    return this.serial(async () => {
      const run = (await this.read<RunRecord>(RUN_PATH))?.value;
      if (run?.id !== result.runId || run.status !== "running" || run.leaseUntil <= this.now()) {
        throw new Error("Benchmark run is no longer active");
      }
      // One transaction publishes result and completion together. Freshness
      // uses the result file's actual mtime, never a client-supplied timestamp.
      validatePairedResult(result);
      const historyPoints = updateHistory(await this.history(null), historyPoint(result));
      this.fs.mkdir("/benchmarks/history", true);
      this.fs.mkdir("/benchmarks/observations", true);
      await this.fs.writeFiles([
        { path: `/benchmarks/history/${result.runId}.json`, body: JSON.stringify(result) },
        ...this.historyWrites(historyPoints),
        { path: RESULT_PATH, body: JSON.stringify(result) },
        { path: RUN_PATH, body: JSON.stringify({ ...run, status: "completed" }) },
      ]);
      const history = this.fs
        .list("/benchmarks/history")
        .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
      const retained = new Set(
        historyPoints.flatMap(
          (point) => point.runs?.map((run) => `/benchmarks/history/${run.runId}.json`) ?? [],
        ),
      );
      for (const entry of history.slice(20))
        if (!retained.has(entry.path)) await this.fs.remove(entry.path);
      const observationPaths = new Set(
        historyPoints.filter((point) => point.runs).map((point) => this.observationPath(point)),
      );
      for (const entry of this.fs.list("/benchmarks/observations"))
        if (!observationPaths.has(entry.path)) await this.fs.remove(entry.path);
      return this.snapshot();
    });
  }

  fail(runId: string, error: string): Promise<BenchmarkSnapshot> {
    return this.serial(async () => {
      const run = (await this.read<RunRecord>(RUN_PATH))?.value;
      if (run?.id === runId && run.status === "running") {
        await this.fs.writeFile(RUN_PATH, JSON.stringify({ ...run, status: "failed", error }));
      }
      return this.snapshot();
    });
  }
}
