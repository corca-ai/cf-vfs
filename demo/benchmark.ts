import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { BENCHMARK_BUILD_ID, BENCHMARK_COMMIT_HASH } from "./benchmark-build.js";
import {
  armOrder,
  MEASUREMENT,
  mergeRows,
  needsValidation,
  PAIRS_PER_RUN,
  PROTOCOL,
  pairedPlan,
} from "./benchmark-protocol.js";
import {
  type BenchmarkDiagnostics,
  type BenchmarkJob,
  type BenchmarkRow,
  BenchmarkStore,
} from "./benchmark-store.js";
import { summarizeStage } from "./benchmark-suite.js";

import {
  runTaskPair,
  TASK_GROUPS,
  TASK_MEASUREMENT,
  TASK_PROTOCOL,
} from "./benchmark-task-runner.js";

const WORKSPACE = "shared-results-v1";

/** Durable coordinator; all timed work belongs to a separate scratch DO. */
export class PublicBenchmarks extends DurableObject<VfsBenchmarkEnv> {
  private readonly store: BenchmarkStore;
  private work: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: VfsBenchmarkEnv) {
    super(ctx, env);
    const fs = new DurableObjectFileSystem(ctx.storage, {
      workspaceId: "public-benchmarks",
      maxEntries: 20_000,
      maxInlineLogicalBytes: 32 * 1024 * 1024,
      maxInFlightBufferedBytes: 16 * 1024 * 1024,
    });
    this.store = new BenchmarkStore(fs);
    ctx.blockConcurrencyWhile(async () => {
      await fs.initialize();
      const state = await this.store.get(false);
      const job = await this.store.job();
      if (state.status === "running" && job !== null && (await ctx.storage.getAlarm()) === null)
        await ctx.storage.setAlarm(Date.now() + 1);
    });
  }
  async snapshot(progressOnly = false) {
    const state = await this.store.get(!progressOnly);
    const job = state.status === "running" ? await this.store.job() : null;
    const progress =
      job === null
        ? null
        : Math.floor((job.nextIndex / (job.task ? TASK_GROUPS : pairedPlan().length)) * 100);
    if (progressOnly)
      return { status: state.status, error: state.error, buildId: BENCHMARK_BUILD_ID, progress };
    return { ...state, buildId: BENCHMARK_BUILD_ID, progress };
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.work.then(operation);
    this.work = result.catch(() => undefined);
    return result;
  }
  claim(
    colo: string | null,
    force = false,
    expectedBuild?: string,
    deploymentId?: string,
    task = false,
  ) {
    return this.exclusive(async () => {
      if (expectedBuild !== undefined && expectedBuild !== BENCHMARK_BUILD_ID)
        throw new Error("Benchmark deployment is still propagating; retry the request");
      const claim = await this.store.claim(force);
      if (claim.runId !== null) {
        await this.store.checkpoint({
          runId: claim.runId,
          task,
          deploymentId: deploymentId ?? this.env.VERSION_METADATA.id,
          buildId: BENCHMARK_BUILD_ID,
          commitHash: BENCHMARK_COMMIT_HASH,
          nextIndex: 0,
          rows: [],
          verified: 0,
          colo,
          diagnostics: [],
          orderOffset: (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 2,
        });
        await this.ctx.storage.setAlarm(Date.now() + 1);
      }
      return claim;
    });
  }
  private async assertDeployment() {
    if ((await this.store.job())?.buildId !== BENCHMARK_BUILD_ID)
      throw new Error("Deployment changed during benchmark; request a new run");
  }
  override async alarm(): Promise<void> {
    const state = await this.store.get(false);
    if (state.status !== "running") return;
    const job = await this.store.job();
    if (!job) return;
    try {
      await this.assertDeployment();
      await this.store.assertActive(job.runId);
      const group = await this.env.BENCHMARK_RUNNER.group(
        job.runId,
        job.nextIndex,
        job.orderOffset ?? 0,
        job.task ?? false,
      );
      await this.exclusive(async () => {
        await this.assertDeployment();
        await this.store.assertActive(job.runId);
        // Alarm redelivery must never count an already published group twice.
        const active = await this.store.job();
        if (active?.nextIndex !== job.nextIndex) return;
        const rows = mergeRows(job.rows, group.rows);
        const next: BenchmarkJob = {
          ...job,
          nextIndex: group.nextIndex,
          rows,
          verified: job.verified + group.verified,
          diagnostics: [...(job.diagnostics ?? []), group.diagnostics],
        };
        if (next.nextIndex === (job.task ? TASK_GROUPS : pairedPlan().length)) {
          const expected = job.task
            ? 1
            : pairedPlan()
                .filter((group) => group.pair === 0)
                .reduce((sum, group) => sum + group.stages.length, 0);
          if (
            rows.length !== expected ||
            rows.some(
              (row) =>
                row.samplesMs.length !== PAIRS_PER_RUN || row.referenceMs?.length !== PAIRS_PER_RUN,
            )
          )
            throw new Error("Incomplete paired benchmark samples");
          await this.store.complete({
            version: 2,
            protocol: job.task ? TASK_PROTOCOL : PROTOCOL,
            diagnostics: next.diagnostics ?? [],
            deploymentId: job.deploymentId ?? this.env.VERSION_METADATA.id,
            buildId: BENCHMARK_BUILD_ID,
            commitHash: job.commitHash ?? BENCHMARK_COMMIT_HASH,
            runId: job.runId,
            completedAt: new Date().toISOString(),
            colo: job.colo,
            engine: "isomorphic-git 1.43.1",
            measurement: job.task ? TASK_MEASUREMENT : MEASUREMENT,
            rows,
            verified: next.verified,
          });
          console.log(
            JSON.stringify({
              message: "paired benchmark completed",
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

/** Alternates complete groups on one DO; its external clock advances during RPC. */
export class BenchmarkRunner extends WorkerEntrypoint<VfsBenchmarkEnv> {
  async group(runId: string, startIndex: number, orderOffset: number, task = false) {
    if (task) return runTaskPair(this.env, runId, startIndex, orderOffset);
    const item = pairedPlan()[startIndex];
    if (!item) throw new Error("Invalid benchmark group");
    const stub = this.env.BENCHMARK_WORKSPACES.getByName("paired-scratch-v2", {
      locationHint: "wnam",
    });
    const order = armOrder(item.pair, orderOffset);
    const versions: Partial<Record<"reference" | "candidate", BenchmarkRow[]>> = {};
    const checks: Partial<Record<"reference" | "candidate", number[]>> = {};
    const diagnostics: BenchmarkDiagnostics = {
      pair: item.pair,
      group: item.group,
      order,
      runnerColo: null,
      referencePingMs: [],
      candidatePingMs: [],
    };
    let verified = 0;
    for (const arm of order) {
      const token = `${runId}:${startIndex}:${arm}`;
      if ((await stub.prepare(token, arm, BENCHMARK_BUILD_ID)) !== BENCHMARK_BUILD_ID)
        throw new Error("Worker and DO benchmark implementations differ");
      const rows: BenchmarkRow[] = [];
      const outcomes: number[] = [];
      const ping = async () => {
        const started = performance.now();
        if ((await stub.ping(token)) !== BENCHMARK_BUILD_ID)
          throw new Error("Benchmark build changed");
        return performance.now() - started;
      };
      const pings = arm === "reference" ? diagnostics.referencePingMs : diagnostics.candidatePingMs;
      try {
        pings.push(await ping());
        for (const stage of item.stages) {
          const started = performance.now();
          const outcome = await stub.stage(token, stage);
          const elapsed = performance.now() - started;
          if (outcome.buildId !== BENCHMARK_BUILD_ID) throw new Error("Benchmark build changed");
          const bodies = needsValidation(stage) ? await stub.validate(token, stage) : 0;
          verified += outcome.verified + bodies;
          outcomes.push(outcome.iterations, outcome.verified, bodies);
          rows.push(summarizeStage(stage, [elapsed], outcome.iterations));
        }
        pings.push(await ping());
      } catch (error) {
        await stub.clear(token).catch((cleanupError) => {
          console.error("Scratch cleanup failed after benchmark failure", String(cleanupError));
        });
        throw error;
      }
      await stub.clear(token);
      versions[arm] = rows;
      checks[arm] = outcomes;
    }
    if (JSON.stringify(checks.reference) !== JSON.stringify(checks.candidate))
      throw new Error("Reference and candidate validations differ");
    const reference = versions.reference;
    const candidate = versions.candidate;
    if (!reference || !candidate) throw new Error("Missing benchmark arm");
    return {
      nextIndex: startIndex + 1,
      verified,
      diagnostics,
      rows:
        item.pair < 0
          ? []
          : candidate.map((row, index) => {
              const paired = reference[index];
              if (!paired) throw new Error("Missing reference workload");
              return { ...row, referenceMs: paired.samplesMs };
            }),
    };
  }
}

export async function handlePublicBenchmarks(
  request: Request,
  env: VfsBenchmarkEnv,
  task = false,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Vfs-Build": BENCHMARK_BUILD_ID,
    "X-Vfs-Deployment": env.VERSION_METADATA.id,
  };
  const stub = env.PUBLIC_BENCHMARKS.getByName(task ? "agent-task-results-v1" : WORKSPACE);
  if (request.method === "GET")
    return Response.json(
      await stub.snapshot(new URL(request.url).searchParams.get("progress") === "1"),
      { headers },
    );
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
    task,
  );
  return Response.json(
    { ...claim.snapshot, reused: claim.runId === null },
    { headers, status: claim.snapshot.status === "running" ? 202 : 200 },
  );
}
