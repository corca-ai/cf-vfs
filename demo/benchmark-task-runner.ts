import { BENCHMARK_BUILD_ID } from "./benchmark-build.js";
import { armOrder, PAIRS_PER_RUN, WARMUP_PAIRS } from "./benchmark-protocol.js";
import type { BenchmarkCost, BenchmarkDiagnostics, BenchmarkRow } from "./benchmark-store.js";
import reference from "./benchmark-task-reference/manifest.json";

export const TASK_PROTOCOL = {
  id: `agent-task-rpc-v1:${reference.seriesHash}`,
  referenceCommit: reference.sourceCommit,
  referenceHash: reference.seriesHash,
  pairsPerRun: PAIRS_PER_RUN,
  warmupPairs: WARMUP_PAIRS,
  credentials: "uid=1000,gid=1000",
};
export const TASK_MEASUREMENT =
  "Agent task v1: 1,000 files / 20 edits; status, sed/redirection/cleanup, grep, add ., commit in independent noninteractive executions. One RPC measures the whole cycle without SQL instrumentation. Fresh fixture and two untimed distinct-content cycles per arm; one warmup pair, six measured alternating pairs on the same DO. Setup and final 1,000-body/clean-status validation excluded. Native SQL costs use a separate equally warmed replay, never included in timing. No sample trimming.";
export const TASK_GROUPS = PAIRS_PER_RUN + WARMUP_PAIRS;

export async function runTaskPair(
  env: VfsBenchmarkEnv,
  runId: string,
  index: number,
  offset: number,
) {
  if (index < 0 || index >= TASK_GROUPS) throw new Error("Invalid task pair");
  const pair = index - WARMUP_PAIRS;
  const order = armOrder(pair, offset);
  const stub = env.BENCHMARK_WORKSPACES.getByName("agent-task-scratch-v1", {
    locationHint: "wnam",
  });
  const times = { reference: 0, candidate: 0 };
  const costs: Record<"reference" | "candidate", BenchmarkCost[]> = {
    reference: [],
    candidate: [],
  };
  const diagnostics: BenchmarkDiagnostics = {
    pair,
    group: 0,
    order,
    runnerColo: null,
    referencePingMs: [],
    candidatePingMs: [],
  };
  let expected: string | undefined;
  let verified = 0;
  // Keep instrumentation out of the timing pass in both arms.
  for (const profile of [false, true])
    for (const arm of order) {
      const token = `${runId}:${index}:${arm}:${profile}`;
      if ((await stub.prepareTask(token, arm, BENCHMARK_BUILD_ID, profile)) !== BENCHMARK_BUILD_ID)
        throw new Error("Task build changed");
      try {
        const pings =
          arm === "reference" ? diagnostics.referencePingMs : diagnostics.candidatePingMs;
        const ping = async () => {
          const start = performance.now();
          if ((await stub.ping(token)) !== BENCHMARK_BUILD_ID)
            throw new Error("Task build changed");
          pings.push(performance.now() - start);
        };
        if (!profile) await ping();
        const start = performance.now();
        const outcome = await stub.taskCycle(token);
        const elapsed = performance.now() - start;
        if (outcome.buildId !== BENCHMARK_BUILD_ID) throw new Error("Task build changed");
        const output = JSON.stringify(outcome.outputs);
        expected ??= output;
        if (output !== expected) throw new Error("Task outputs/commit identities differ");
        if (profile) {
          if (!outcome.costs) throw new Error("Missing native SQL costs");
          costs[arm].push(outcome.costs);
        } else {
          times[arm] = elapsed;
          await ping();
        }
        verified += await stub.validateTask(token);
      } catch (error) {
        await stub
          .clear(token)
          .catch((cleanupError) => console.error("Task cleanup failed", String(cleanupError)));
        throw error;
      }
      await stub.clear(token);
    }
  const rows: BenchmarkRow[] =
    pair < 0
      ? []
      : [
          {
            group: "agent-task",
            operation: "cycle",
            files: 1000,
            cache: false,
            iterations: 1,
            samplesMs: [times.candidate],
            referenceMs: [times.reference],
            medianMs: times.candidate,
            minMs: times.candidate,
            maxMs: times.candidate,
            costs,
          },
        ];
  return { nextIndex: index + 1, verified, diagnostics, rows };
}
