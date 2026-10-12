import reference from "./benchmark-reference/manifest.json";
import type { BenchmarkRow } from "./benchmark-store.js";
import { type BenchmarkStage, benchmarkPlan } from "./benchmark-suite.js";

export const PAIRS_PER_RUN = 6;
export const WARMUP_PAIRS = 1;
export const PROTOCOL = {
  id: `paired-rpc-v2:${reference.seriesHash}`,
  referenceCommit: reference.sourceCommit,
  referenceHash: reference.seriesHash,
  pairsPerRun: PAIRS_PER_RUN,
  warmupPairs: WARMUP_PAIRS,
  credentials: "unbound",
} as const;
export const MEASUREMENT =
  "Paired RPC v2: frozen reference and current code in the same scratch DO, fresh fixture per arm/group, balanced alternating order, fixed Git identity time, one warmup pair and six measured pairs. Coordinator I/O, fixture initialization and full-body validation excluded; operation assertions and RPC/storage waits included. Recovery rows include their own setup and validation. Zero times remain unresolved; no sample trimming.";
export type BenchmarkArm = "reference" | "candidate";
export function armOrder(pair: number, offset: number): BenchmarkArm[] {
  return (pair + offset) % 2 === 0 ? ["reference", "candidate"] : ["candidate", "reference"];
}
export function benchmarkGroups(): BenchmarkStage[][] {
  const groups: BenchmarkStage[][] = [];
  for (const stage of benchmarkPlan().filter((s) => s.trial === 0)) {
    const last = groups.at(-1);
    const first = last?.[0];
    if (first?.group === stage.group && first.files === stage.files && first.cache === stage.cache)
      last?.push(stage);
    else groups.push([stage]);
  }
  return groups;
}
export function pairedPlan() {
  const groups = benchmarkGroups();
  return Array.from({ length: PAIRS_PER_RUN + WARMUP_PAIRS }, (_, round) =>
    groups.map((stages, group) => ({ pair: round - WARMUP_PAIRS, group, stages })),
  ).flat();
}
export function needsValidation(stage: BenchmarkStage) {
  return (
    (["coding-small", "coding-mixed"].includes(stage.group) &&
      ["clone", "commit-partial", "checkout-base", "checkout-main"].includes(stage.operation)) ||
    stage.operation === "remove-tree" ||
    stage.operation === "checkout-main" ||
    (stage.group === "git-shell" &&
      ["add-one", "add-changed", "add-removals"].includes(stage.operation))
  );
}
export function rowKey(
  row: Pick<BenchmarkRow, "group" | "operation" | "files" | "cache" | "iterations">,
) {
  return JSON.stringify([row.group, row.operation, row.files, row.cache, row.iterations]);
}
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new Error("No samples");
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  if (upper === undefined) throw new Error("No middle sample");
  return sorted.length % 2 ? upper : ((lower ?? upper) + upper) / 2;
}
export function mergeRows(rows: BenchmarkRow[], incoming: BenchmarkRow[]): BenchmarkRow[] {
  const next = [...rows];
  for (const row of incoming) {
    const index = next.findIndex((r) => rowKey(r) === rowKey(row));
    const old = next[index];
    const samplesMs = [...(old?.samplesMs ?? []), ...row.samplesMs];
    const referenceMs = [...(old?.referenceMs ?? []), ...(row.referenceMs ?? [])];
    const merged = {
      ...row,
      samplesMs,
      referenceMs,
      medianMs: median(samplesMs),
      minMs: Math.min(...samplesMs),
      maxMs: Math.max(...samplesMs),
    };
    if (index < 0) next.push(merged);
    else next[index] = merged;
  }
  return next;
}
