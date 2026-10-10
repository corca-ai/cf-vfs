import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { BENCHMARK_BUILD_ID, BENCHMARK_COMMIT_HASH } from "./benchmark-build.js";
import { type BenchmarkJob, type BenchmarkRow, BenchmarkStore } from "./benchmark-store.js";
import { benchmarkPlan, PublicBenchmarkSuite, summarizeStage } from "./benchmark-suite.js";

const WORKSPACE = "shared-results-v1";

/** The coordinator, scratch filesystem, lease and result share one bounded DO. */
export class PublicBenchmarks extends DurableObject<VfsBenchmarkEnv> {
  private readonly store: BenchmarkStore;
  private readonly suite: PublicBenchmarkSuite;
  private work: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: VfsBenchmarkEnv) {
    super(ctx, env);
    let suite: PublicBenchmarkSuite | undefined;
    const fs = new DurableObjectFileSystem(ctx.storage, {
      workspaceId: "public-benchmarks",
      maxEntries: 20_000,
      maxInlineLogicalBytes: 32 * 1024 * 1024,
      maxInFlightBufferedBytes: 16 * 1024 * 1024,
      onEvent: (event) => suite?.onEvent(event),
    });
    this.suite = suite = new PublicBenchmarkSuite(fs);
    this.store = new BenchmarkStore(fs);
    ctx.blockConcurrencyWhile(async () => {
      await fs.initialize();
      const state = await this.store.get();
      const job = await this.store.job();
      if (state.status === "running" && job !== null && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + 1);
      }
    });
  }

  async snapshot() {
    const state = await this.store.get();
    const job = state.status === "running" ? await this.store.job() : null;
    return {
      ...state,
      buildId: BENCHMARK_BUILD_ID,
      progress: job === null ? null : Math.floor((job.nextIndex / benchmarkPlan().length) * 100),
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.work.then(operation);
    this.work = result.catch(() => undefined);
    return result;
  }

  claim(colo: string | null, force = false, expectedBuild?: string, deploymentId?: string) {
    return this.exclusive(async () => {
      if (expectedBuild !== undefined && expectedBuild !== BENCHMARK_BUILD_ID)
        throw new Error("Benchmark deployment is still propagating; retry the request");
      const claim = await this.store.claim(force);
      if (claim.runId !== null) {
        await this.store.checkpoint({
          runId: claim.runId,
          deploymentId: deploymentId ?? this.env.VERSION_METADATA.id,
          buildId: BENCHMARK_BUILD_ID,
          commitHash: BENCHMARK_COMMIT_HASH,
          nextIndex: 0,
          rows: [],
          verified: 0,
          colo,
        });
        await this.ctx.storage.setAlarm(Date.now() + 1);
      }
      return claim;
    });
  }

  private async assertDeployment() {
    const job = await this.store.job();
    if (job?.buildId !== BENCHMARK_BUILD_ID)
      throw new Error("Deployment changed during benchmark; request a new run");
  }

  stage(runId: string, index: number) {
    return this.exclusive(async () => {
      await this.assertDeployment();
      await this.store.assertActive(runId);
      const stage = benchmarkPlan()[index];
      if (stage === undefined) throw new Error("Invalid benchmark stage");
      const outcome = await this.suite.run(stage);
      return { ...outcome, buildId: BENCHMARK_BUILD_ID };
    });
  }

  validate(runId: string, index: number) {
    return this.exclusive(async () => {
      await this.assertDeployment();
      await this.store.assertActive(runId);
      const stage = benchmarkPlan()[index];
      if (stage === undefined) throw new Error("Invalid benchmark stage");
      return this.suite.validate(stage);
    });
  }

  override async alarm(): Promise<void> {
    const state = await this.store.get();
    if (state.status !== "running") return;
    const job = await this.store.job();
    if (job === null) return;
    try {
      await this.assertDeployment();
      await this.store.assertActive(job.runId);
      const group = await this.env.BENCHMARK_RUNNER.group(job.runId, job.nextIndex);
      await this.exclusive(async () => {
        await this.assertDeployment();
        await this.store.assertActive(job.runId);
        const rows = [...job.rows];
        for (const incoming of group.rows) {
          const index = rows.findIndex(
            (row) =>
              row.group === incoming.group &&
              row.operation === incoming.operation &&
              row.files === incoming.files &&
              row.cache === incoming.cache,
          );
          const existing = rows[index];
          const samplesMs = [...(existing?.samplesMs ?? []), ...incoming.samplesMs];
          const sorted = [...samplesMs].sort((a, b) => a - b);
          const merged: BenchmarkRow = {
            ...incoming,
            samplesMs,
            medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
            minMs: sorted[0] ?? 0,
            maxMs: sorted.at(-1) ?? 0,
          };
          if (index < 0) rows.push(merged);
          else rows[index] = merged;
        }
        const next: BenchmarkJob = {
          ...job,
          nextIndex: group.nextIndex,
          rows,
          verified: job.verified + group.verified,
        };
        if (next.nextIndex === benchmarkPlan().length) {
          const expectedRows = benchmarkPlan().filter((stage) => stage.trial === 0).length;
          if (rows.length !== expectedRows || rows.some((row) => row.samplesMs.length !== 3))
            throw new Error("Incomplete benchmark samples");
          await this.suite.cleanup();
          await this.store.complete({
            version: 1,
            deploymentId: job.deploymentId ?? this.env.VERSION_METADATA.id,
            buildId: BENCHMARK_BUILD_ID,
            commitHash: job.commitHash ?? BENCHMARK_COMMIT_HASH,
            runId: job.runId,
            completedAt: new Date().toISOString(),
            colo: job.colo,
            engine: "isomorphic-git 1.43.1",
            measurement:
              "Worker-to-Durable-Object RPC wall time, including dispatch and operation assertions; full-body validation and teardown excluded for operation rows; recovery rows include setup, injected fault, retry, validation and teardown. Coding mixed profiles include four 256 KiB bodies. One warmup and three measured runs. Direct-engine Git add batches 32 files; shell Git uses implementation-bounded batches. SQLite-backed VFS, inline bodies; no R2 or external Git network.",
            rows,
            verified: next.verified,
          });
          console.log(
            JSON.stringify({
              message: "public benchmark completed",
              runId: job.runId,
              verified: next.verified,
            }),
          );
        } else {
          await this.store.checkpoint(next);
          await this.ctx.storage.setAlarm(Date.now() + 1);
        }
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "public benchmark failed",
          runId: job.runId,
          index: job.nextIndex,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.exclusive(() =>
        this.store.fail(
          job.runId,
          "Benchmark did not complete. The previous saved result is retained; you can request a retry.",
        ),
      );
    }
  }
}

/** Measures RPC from outside the DO, so the production platform clock advances. */
export class BenchmarkRunner extends WorkerEntrypoint<VfsBenchmarkEnv> {
  async group(runId: string, startIndex: number) {
    const stub = this.env.PUBLIC_BENCHMARKS.getByName(WORKSPACE);
    const plan = benchmarkPlan();
    const initial = plan[startIndex];
    if (initial === undefined) throw new Error("Invalid benchmark group");
    const rows: BenchmarkRow[] = [];
    let nextIndex = startIndex;
    let verified = 0;
    for (; nextIndex < plan.length; nextIndex += 1) {
      const stage = plan[nextIndex];
      if (
        stage === undefined ||
        stage.group !== initial.group ||
        stage.files !== initial.files ||
        stage.cache !== initial.cache ||
        stage.trial !== initial.trial
      )
        break;
      const started = performance.now();
      const outcome = await stub.stage(runId, nextIndex);
      const elapsed = performance.now() - started;
      if (outcome.buildId !== BENCHMARK_BUILD_ID)
        throw new Error("Worker and DO benchmark implementations differ");
      verified += outcome.verified;
      if (stage.trial >= 0) rows.push(summarizeStage(stage, [elapsed], outcome.iterations));
      if (
        (["coding-small", "coding-mixed"].includes(stage.group) &&
          ["clone", "commit-partial", "checkout-base", "checkout-main"].includes(
            stage.operation,
          )) ||
        stage.operation === "remove-tree" ||
        stage.operation === "checkout-main" ||
        (stage.group === "git-shell" &&
          ["add-one", "add-changed", "add-removals"].includes(stage.operation))
      )
        verified += await stub.validate(runId, nextIndex);
    }
    return { nextIndex, rows, verified };
  }
}

export async function handlePublicBenchmarks(
  request: Request,
  env: VfsBenchmarkEnv,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Vfs-Build": BENCHMARK_BUILD_ID,
    "X-Vfs-Deployment": env.VERSION_METADATA.id,
  };
  const stub = env.PUBLIC_BENCHMARKS.getByName(WORKSPACE);
  if (request.method === "GET") return Response.json(await stub.snapshot(), { headers });
  if (request.method !== "POST")
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { ...headers, Allow: "GET, POST" } },
    );
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin)
    return Response.json({ error: "Origin not allowed" }, { status: 403, headers });
  const claim = await stub.claim(
    typeof request.cf?.colo === "string" ? request.cf.colo : null,
    false,
    BENCHMARK_BUILD_ID,
    env.VERSION_METADATA.id,
  );
  return Response.json(
    { ...claim.snapshot, reused: claim.runId === null },
    { headers, status: claim.snapshot.status === "running" ? 202 : 200 },
  );
}
