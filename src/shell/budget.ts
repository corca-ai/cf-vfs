import { VfsError, type VfsErrorCode } from "../core/errors.js";
import { emitShellEvent, type ShellEventSink } from "./events.js";
import type { ShellBudget, ShellLimits } from "./types.js";

export const MAX_PIPELINE_EDGE_BYTES = 8 * 1024 * 1024;

export const DEFAULT_SHELL_LIMITS: ShellLimits = {
  maxScriptBytes: 1024 * 1024,
  maxTotalSourceBytes: 4 * 1024 * 1024,
  maxAstNodes: 10_000,
  maxNestingDepth: 64,
  maxCommands: 10_000,
  maxSteps: 100_000,
  maxLoopIterations: 10_000,
  maxFunctionDepth: 64,
  maxSourceDepth: 16,
  maxScriptDepth: 8,
  maxCommandSubstitutionBytes: 1024 * 1024,
  maxPipelineBytes: 8 * 1024 * 1024,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 8 * 1024 * 1024,
  maxMaterializedOutputBytes: 8 * 1024 * 1024,
  maxTotalIoBytes: 32 * 1024 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxBufferedRecords: 100_000,
  maxGlobMatches: 10_000,
  maxExpansionWork: 10_000_000,
  maxExpansionChars: 1024 * 1024,
  maxExpansionFields: 10_000,
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
    throw new VfsError("EINVAL", `maxPipelineBytes cannot exceed ${MAX_PIPELINE_EDGE_BYTES}`);
  }
  return limits;
}

export class ExecutionBudget implements ShellBudget {
  readonly limits: ShellLimits;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly onEvent: ShellEventSink | undefined;
  private steps = 0;
  private commands = 0;
  private loopIterations = 0;
  private ioBytes = 0;
  private mutations = 0;
  private globMatches = 0;
  private expansionCharacters = 0;
  private expansionFields = 0;
  private expansionWorkUnits = 0;
  private bufferedBytes = 0;

  constructor(limits: ShellLimits, now: () => number, onEvent?: ShellEventSink) {
    this.limits = limits;
    this.now = now;
    this.onEvent = onEvent;
    this.startedAtMs = now();
  }

  /** Reports the limit that refused work, then fails. */
  private exceeded(
    limit: keyof ShellLimits,
    used: number,
    code: VfsErrorCode,
    message: string,
  ): never {
    emitShellEvent(this.onEvent, {
      type: "shell.limit",
      limit,
      used,
      max: this.limits[limit],
    });
    throw new VfsError(code, message);
  }

  elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }

  checkDeadline(): void {
    const elapsed = this.elapsedMs();
    if (elapsed > this.limits.deadlineMs) {
      this.exceeded("deadlineMs", elapsed, "ETIMEDOUT", "shell execution deadline exceeded");
    }
  }

  remainingDeadlineMs(): number {
    return Math.max(0, this.limits.deadlineMs - (this.now() - this.startedAtMs));
  }

  step(count = 1): void {
    this.checkDeadline();
    this.steps += count;
    if (this.steps > this.limits.maxSteps) {
      this.exceeded("maxSteps", this.steps, "E2BIG", "shell execution step limit exceeded");
    }
  }

  command(): void {
    this.step();
    this.commands += 1;
    if (this.commands > this.limits.maxCommands) {
      this.exceeded("maxCommands", this.commands, "E2BIG", "shell command limit exceeded");
    }
  }

  loop(): void {
    this.step();
    this.loopIterations += 1;
    if (this.loopIterations > this.limits.maxLoopIterations) {
      this.exceeded(
        "maxLoopIterations",
        this.loopIterations,
        "E2BIG",
        "shell loop iteration limit exceeded",
      );
    }
  }

  io(bytes: number): void {
    this.checkDeadline();
    this.ioBytes += bytes;
    if (this.ioBytes > this.limits.maxTotalIoBytes) {
      this.exceeded(
        "maxTotalIoBytes",
        this.ioBytes,
        "E2BIG",
        "shell total I/O byte limit exceeded",
      );
    }
  }

  mutation(count = 1): void {
    this.checkDeadline();
    this.mutations += count;
    if (this.mutations > this.limits.maxMutations) {
      this.exceeded(
        "maxMutations",
        this.mutations,
        "E2BIG",
        "shell filesystem mutation limit exceeded",
      );
    }
  }

  glob(count = 1): void {
    this.checkDeadline();
    this.globMatches += count;
    if (this.globMatches > this.limits.maxGlobMatches) {
      this.exceeded(
        "maxGlobMatches",
        this.globMatches,
        "E2BIG",
        "pathname expansion match limit exceeded",
      );
    }
  }

  expansionWork(count = 1): void {
    this.checkDeadline();
    this.expansionWorkUnits += count;
    if (this.expansionWorkUnits > this.limits.maxExpansionWork) {
      this.exceeded(
        "maxExpansionWork",
        this.expansionWorkUnits,
        "E2BIG",
        "shell expansion work limit exceeded",
      );
    }
  }

  checkExpansionOutput(characters: number, fields = 1): void {
    this.checkDeadline();
    if (this.expansionCharacters + characters > this.limits.maxExpansionChars) {
      this.exceeded(
        "maxExpansionChars",
        this.expansionCharacters + characters,
        "E2BIG",
        "shell expansion character limit exceeded",
      );
    }
    if (this.expansionFields + fields > this.limits.maxExpansionFields) {
      this.exceeded(
        "maxExpansionFields",
        this.expansionFields + fields,
        "E2BIG",
        "shell expansion field limit exceeded",
      );
    }
  }

  expansionOutput(characters: number, fields = 1): void {
    this.checkExpansionOutput(characters, fields);
    this.expansionCharacters += characters;
    this.expansionFields += fields;
  }

  buffered(bytes: number): () => void {
    this.checkDeadline();
    this.bufferedBytes += bytes;
    if (this.bufferedBytes > this.limits.maxBufferedBytes) {
      const attempted = this.bufferedBytes;
      this.bufferedBytes -= bytes;
      this.exceeded("maxBufferedBytes", attempted, "E2BIG", "shell buffered-byte limit exceeded");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bufferedBytes -= bytes;
    };
  }
}
