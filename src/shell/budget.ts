import { VfsError } from "../core/errors.js";
import type { ShellBudget, ShellLimits } from "./types.js";

export const MAX_PIPELINE_EDGE_BYTES = 8 * 1024 * 1024;

export const DEFAULT_SHELL_LIMITS: ShellLimits = {
  maxScriptBytes: 1024 * 1024,
  maxAstNodes: 10_000,
  maxNestingDepth: 64,
  maxCommands: 10_000,
  maxSteps: 100_000,
  maxPipelineBytes: 8 * 1024 * 1024,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 8 * 1024 * 1024,
  maxMaterializedOutputBytes: 8 * 1024 * 1024,
  maxTotalIoBytes: 32 * 1024 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxBufferedRecords: 100_000,
  maxGlobMatches: 10_000,
  maxMutations: 10_000,
  deadlineMs: 30_000,
  outputIdleTimeoutMs: 5_000,
};

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VfsError("EINVAL", `${name} must be a positive safe integer`);
  }
  return value;
}

export function resolveShellLimits(input: Partial<ShellLimits> = {}): ShellLimits {
  const limits = { ...DEFAULT_SHELL_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) positive(value, name);
  if (limits.maxPipelineBytes > MAX_PIPELINE_EDGE_BYTES) {
    throw new VfsError(
      "EINVAL",
      `maxPipelineBytes cannot exceed ${MAX_PIPELINE_EDGE_BYTES}`,
    );
  }
  return limits;
}

export class ExecutionBudget implements ShellBudget {
  readonly limits: ShellLimits;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private steps = 0;
  private commands = 0;
  private ioBytes = 0;
  private mutations = 0;
  private globMatches = 0;
  private bufferedBytes = 0;

  constructor(limits: ShellLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
    this.startedAtMs = now();
  }

  checkDeadline(): void {
    if (this.now() - this.startedAtMs > this.limits.deadlineMs) {
      throw new VfsError("ETIMEDOUT", "shell execution deadline exceeded");
    }
  }

  step(count = 1): void {
    this.checkDeadline();
    this.steps += count;
    if (this.steps > this.limits.maxSteps) {
      throw new VfsError("E2BIG", "shell execution step limit exceeded");
    }
  }

  command(): void {
    this.step();
    this.commands += 1;
    if (this.commands > this.limits.maxCommands) {
      throw new VfsError("E2BIG", "shell command limit exceeded");
    }
  }

  io(bytes: number): void {
    this.checkDeadline();
    this.ioBytes += bytes;
    if (this.ioBytes > this.limits.maxTotalIoBytes) {
      throw new VfsError("E2BIG", "shell total I/O byte limit exceeded");
    }
  }

  mutation(count = 1): void {
    this.checkDeadline();
    this.mutations += count;
    if (this.mutations > this.limits.maxMutations) {
      throw new VfsError("E2BIG", "shell filesystem mutation limit exceeded");
    }
  }

  glob(count = 1): void {
    this.checkDeadline();
    this.globMatches += count;
    if (this.globMatches > this.limits.maxGlobMatches) {
      throw new VfsError("E2BIG", "pathname expansion match limit exceeded");
    }
  }

  buffered(bytes: number): () => void {
    this.checkDeadline();
    this.bufferedBytes += bytes;
    if (this.bufferedBytes > this.limits.maxBufferedBytes) {
      this.bufferedBytes -= bytes;
      throw new VfsError("E2BIG", "shell buffered-byte limit exceeded");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bufferedBytes -= bytes;
    };
  }
}
