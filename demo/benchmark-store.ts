import { VfsError } from "../src/core/errors.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";

export const RESULT_PATH = "/benchmarks/latest.json";
const JOB_PATH = "/benchmarks/job.json";
const RUN_PATH = "/benchmarks/run.json";
export const BENCHMARK_TTL_MS = 10 * 60 * 1000;
const RUN_LEASE_MS = 5 * 60 * 1000;

export interface BenchmarkRow {
  group: "files" | "git" | "git-shell" | "coding-small" | "coding-mixed" | "git-recovery";
  operation: string;
  files: number;
  cache: boolean;
  iterations: number;
  samplesMs: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface PublicBenchmarkResult {
  version: 1;
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

export interface BenchmarkJob {
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

export interface BenchmarkSnapshot {
  status: "empty" | "ready" | "running" | "failed";
  result: PublicBenchmarkResult | null;
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

  private async snapshot(): Promise<BenchmarkSnapshot> {
    const saved = await this.read<PublicBenchmarkResult>(RESULT_PATH);
    const run = (await this.read<RunRecord>(RUN_PATH))?.value;
    const running = run?.status === "running" && run.leaseUntil > this.now();
    const failed = run?.status === "failed" || (run?.status === "running" && !running);
    const resultNext = saved === null ? null : saved.modifiedAt + BENCHMARK_TTL_MS;
    return {
      status: running ? "running" : failed ? "failed" : saved === null ? "empty" : "ready",
      result: saved?.value ?? null,
      modifiedAt: saved?.modifiedAt ?? null,
      nextRunAt: resultNext,
      error: failed
        ? (run?.error ?? "The previous run was interrupted. Please request it again.")
        : null,
    };
  }

  get(): Promise<BenchmarkSnapshot> {
    return this.serial(() => this.snapshot());
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
      this.fs.mkdir("/benchmarks/history", true);
      await this.fs.writeFiles([
        { path: `/benchmarks/history/${result.runId}.json`, body: JSON.stringify(result) },
        { path: RESULT_PATH, body: JSON.stringify(result) },
        { path: RUN_PATH, body: JSON.stringify({ ...run, status: "completed" }) },
      ]);
      const history = this.fs
        .list("/benchmarks/history")
        .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
      for (const entry of history.slice(20)) await this.fs.remove(entry.path);
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
