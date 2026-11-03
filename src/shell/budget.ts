import { VfsError, type VfsErrorCode } from "../core/errors.js";
import { emitShellEvent, type ShellEventSink, type ShellLimitConsumer } from "./events.js";
import type { ShellBudget, ShellDerivedLimits, ShellLimits } from "./types.js";

const MiB = 1024 * 1024;

/** The most a redirection may buffer before it publishes a file. */
export const MAX_PIPELINE_EDGE_BYTES = 8 * MiB;

export const DEFAULT_SHELL_LIMITS: ShellLimits = {
  deadlineMs: 30_000,
  maxWork: 10_000_000,
  maxMemoryBytes: 16 * MiB,
  maxDepth: 64,
  maxRowsWritten: 50_000,
};

/**
 * What each kind of work costs in units of `maxWork`: about a microsecond of
 * CPU on local workerd, taken at the high end of what each kind measured
 * (`bench/limits-calibration-2026-11-03/`). A shell step is about 2 µs, a
 * command 4 µs more, and a unit of expansion work 0.25 µs. A byte read from a
 * file body or moved through a pipe, a file or output is 20 ns: reading or
 * moving it costs a few, and what the command does with it — `sort -n`
 * parsing it, `od` formatting it — costs the rest.
 */
const WORK_COST = {
  step: 2,
  command: 4,
  expansion: 0.25,
  read: 0.02,
  io: 0.02,
} as const;

/** Bytes per SQLite row of file content, the default chunk size. */
const ROW_BYTES = 256 * 1024;

/**
 * SQLite rows one changed entry is estimated to write: the entry, its
 * metadata and the indexes over them, measured at one to four.
 */
const ROWS_PER_MUTATION = 4;

const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** Commands and loop iterations between turns of the event loop. */
const COMMANDS_PER_PAUSE = 32_768;

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VfsError("EINVAL", `${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * The caps the shell and its applets check, derived from the five limits.
 *
 * What one structure may hold — a line, an expansion, a captured output, the
 * records `sort` keeps — scales with `maxMemoryBytes`, and at its default
 * each is what 0.5 set it to. Nesting scales with `maxDepth`. Steps, commands,
 * expansion, reads and I/O all charge `maxWork` and have no cap of their own,
 * and mutations charge `maxRowsWritten`.
 */
export function deriveShellLimits(limits: ShellLimits): ShellDerivedLimits {
  const scale = limits.maxMemoryBytes / DEFAULT_SHELL_LIMITS.maxMemoryBytes;
  const memory = (atDefault: number) => Math.max(1, Math.floor(atDefault * scale));
  return {
    ...limits,
    maxScriptBytes: memory(MiB),
    maxTotalSourceBytes: memory(4 * MiB),
    maxAstNodes: memory(10_000),
    maxCommandSubstitutionBytes: memory(MiB),
    maxPipelineBytes: Math.min(MAX_PIPELINE_EDGE_BYTES, memory(8 * MiB)),
    maxStdoutBytes: memory(8 * MiB),
    maxStderrBytes: memory(8 * MiB),
    maxMaterializedOutputBytes: memory(8 * MiB),
    maxBufferedBytes: limits.maxMemoryBytes,
    maxLineBytes: memory(MiB),
    maxBufferedRecords: memory(100_000),
    maxGlobMatches: memory(65_536),
    maxExpansionChars: memory(MiB),
    maxExpansionFields: memory(65_536),
    maxNestingDepth: limits.maxDepth,
    maxFunctionDepth: limits.maxDepth,
    maxSourceDepth: Math.max(1, Math.floor(limits.maxDepth / 4)),
    maxScriptDepth: Math.max(1, Math.floor(limits.maxDepth / 8)),
    maxSteps: UNLIMITED,
    maxCommands: UNLIMITED,
    maxLoopIterations: UNLIMITED,
    maxExpansionWork: UNLIMITED,
    maxReadBytes: UNLIMITED,
    maxTotalIoBytes: UNLIMITED,
    maxMutations: UNLIMITED,
    outputIdleTimeoutMs: Math.min(5_000, limits.deadlineMs),
  };
}

/**
 * Resolves a host's limits.
 *
 * 0.5's names are still accepted, deprecated: each sets the derived cap of
 * that name directly. A counter's cap — steps, commands, expansion work, bytes
 * read or moved, mutations — can only tighten, since `maxWork` and
 * `maxRowsWritten` still apply; a structure's cap replaces the one
 * `maxMemoryBytes` implies. Any other name is refused.
 */
export function resolveShellLimits(
  input: Partial<ShellLimits> | Partial<ShellDerivedLimits> = {},
): ShellDerivedLimits {
  const limits: ShellLimits = { ...DEFAULT_SHELL_LIMITS };
  const caps: Record<string, number> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Object.hasOwn(DEFAULT_SHELL_LIMITS, name)) limits[name as keyof ShellLimits] = value;
    else caps[name] = value;
  }
  for (const [name, value] of Object.entries(limits)) positive(value, name);
  const derived = deriveShellLimits(limits);
  for (const [name, value] of Object.entries(caps)) {
    if (!Object.hasOwn(derived, name)) throw new VfsError("EINVAL", `${name} is not a shell limit`);
    (derived as unknown as Record<string, number>)[name] = positive(value, name);
  }
  if (derived.maxPipelineBytes > MAX_PIPELINE_EDGE_BYTES) {
    throw new VfsError("EINVAL", `maxPipelineBytes cannot exceed ${MAX_PIPELINE_EDGE_BYTES}`);
  }
  return derived;
}

/** What `maxWork` is spent on, as an error and a `shell.limit` event report it. */
const WORK_KINDS = [
  "shell steps",
  "commands",
  "expansion",
  "file reads",
  "pipes and output",
] as const;
type WorkKind = (typeof WORK_KINDS)[number];

function formatUnits(units: number): string {
  if (units >= 1e6) return `${(units / 1e6).toFixed(1)}M`;
  if (units >= 1e3) return `${(units / 1e3).toFixed(1)}k`;
  return String(Math.round(units));
}

export class ExecutionBudget implements ShellBudget {
  readonly limits: ShellDerivedLimits;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly onEvent: ShellEventSink | undefined;
  private steps = 0;
  private commands = 0;
  private loopIterations = 0;
  private ioBytes = 0;
  private readBytes = 0;
  private diagnostics = false;
  private mutations = 0;
  private rowsWritten = 0;
  private expansionWorkUnits = 0;
  private bufferedBytes = 0;
  private work = 0;
  private sincePause = 0;
  private readonly workByKind = Object.fromEntries(WORK_KINDS.map((kind) => [kind, 0])) as Record<
    WorkKind,
    number
  >;

  /** Takes derived limits; the five alone are derived here, so no cap is left unset. */
  constructor(
    limits: ShellDerivedLimits | ShellLimits,
    now: () => number,
    onEvent?: ShellEventSink,
  ) {
    this.limits = "maxLineBytes" in limits ? limits : deriveShellLimits(limits);
    this.now = now;
    this.onEvent = onEvent;
    this.startedAtMs = now();
  }

  /** Reports the limit that refused work, then fails. */
  private exceeded(
    limit: keyof ShellDerivedLimits,
    used: number,
    code: VfsErrorCode,
    message: string,
    breakdown?: readonly ShellLimitConsumer[],
  ): never {
    emitShellEvent(this.onEvent, {
      type: "shell.limit",
      limit,
      used,
      max: this.limits[limit],
      ...(breakdown === undefined ? {} : { breakdown }),
    });
    throw new VfsError(code, message);
  }

  /** Spends `units` of `maxWork` on `kind`. */
  private charge(kind: WorkKind, units: number): void {
    this.work += units;
    this.workByKind[kind] += units;
    if (this.work <= this.limits.maxWork) return;
    const breakdown = WORK_KINDS.map((consumer) => ({
      consumer,
      amount: Math.round(this.workByKind[consumer]),
    }))
      .filter((entry) => entry.amount > 0)
      .sort((left, right) => right.amount - left.amount)
      .slice(0, 3);
    const spent = breakdown.map((entry) => `${entry.consumer} ${formatUnits(entry.amount)}`);
    this.exceeded(
      "maxWork",
      Math.round(this.work),
      "E2BIG",
      `shell work limit exceeded (${spent.join(", ")})`,
      breakdown,
    );
  }

  /**
   * Every 32,768 commands or loop iterations, a promise that lets the event
   * loop run. Workers freeze the clock and inline reads never yield, so
   * without a turn neither the deadline's timer nor a cancellation can stop a
   * shell loop before `maxWork` does, and nothing else the object serves runs
   * meanwhile.
   */
  pause(): Promise<void> | undefined {
    this.sincePause += 1;
    if (this.sincePause < COMMANDS_PER_PAUSE) return undefined;
    this.sincePause = 0;
    return new Promise((resolve) => setTimeout(resolve, 0));
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
    this.charge("shell steps", count * WORK_COST.step);
  }

  command(): void {
    this.step();
    this.commands += 1;
    if (this.commands > this.limits.maxCommands) {
      this.exceeded("maxCommands", this.commands, "E2BIG", "shell command limit exceeded");
    }
    this.charge("commands", WORK_COST.command);
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

  /**
   * Stops charging I/O once the unit has failed, so the diagnostic that says
   * why can still be written; it is bounded by the stderr limit instead.
   */
  releaseForDiagnostics(): void {
    this.diagnostics = true;
  }

  io(bytes: number): void {
    if (this.diagnostics) return;
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
    this.charge("pipes and output", bytes * WORK_COST.io);
  }

  read(bytes: number): void {
    if (this.diagnostics) return;
    this.checkDeadline();
    this.readBytes += bytes;
    if (this.readBytes > this.limits.maxReadBytes) {
      this.exceeded("maxReadBytes", this.readBytes, "E2BIG", "shell file read byte limit exceeded");
    }
    this.charge("file reads", bytes * WORK_COST.read);
  }

  /**
   * Charges `count` changed entries, at an estimated four SQLite rows each —
   * the first chunk of content among them — and a row for each further
   * 256 KiB chunk of the `bytes` they write.
   */
  mutation(count = 1, bytes = 0): void {
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
    this.rowsWritten +=
      count * ROWS_PER_MUTATION + Math.max(0, Math.ceil(bytes / ROW_BYTES) - count);
    if (this.rowsWritten > this.limits.maxRowsWritten) {
      this.exceeded("maxRowsWritten", this.rowsWritten, "E2BIG", "shell row-write limit exceeded");
    }
  }

  /**
   * Bounds the entries one pathname expansion or one `find` traversal holds
   * at once. The limit is per result, like the expansion limits, because what
   * it protects is memory; the running total is charged to expansion work.
   */
  glob(count = 1): void {
    this.checkDeadline();
    if (count > this.limits.maxGlobMatches) {
      this.exceeded("maxGlobMatches", count, "E2BIG", "pathname expansion match limit exceeded");
    }
    this.expansionWork(count);
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
    this.charge("expansion", count * WORK_COST.expansion);
  }

  /**
   * Bounds one expansion's result: the characters and fields a single word
   * list, substitution, or utility value materializes at once. The limits
   * are per result rather than per execution, because what they protect is
   * memory held at one time; a loop that expands a short word ten thousand
   * times holds one word at a time. The running total is charged as expansion
   * work by `expansionOutput`, which bounds the whole unit.
   */
  checkExpansionOutput(characters: number, fields = 1): void {
    this.checkDeadline();
    if (characters > this.limits.maxExpansionChars) {
      this.exceeded(
        "maxExpansionChars",
        characters,
        "E2BIG",
        "shell expansion character limit exceeded",
      );
    }
    if (fields > this.limits.maxExpansionFields) {
      this.exceeded("maxExpansionFields", fields, "E2BIG", "shell expansion field limit exceeded");
    }
  }

  expansionOutput(characters: number, fields = 1): void {
    this.checkExpansionOutput(characters, fields);
    this.expansionWork(characters + fields);
  }

  remainingBufferedBytes(): number {
    return this.limits.maxBufferedBytes - this.bufferedBytes;
  }

  buffered(bytes: number): () => void {
    this.checkDeadline();
    this.bufferedBytes += bytes;
    if (this.bufferedBytes > this.limits.maxBufferedBytes) {
      const attempted = this.bufferedBytes;
      this.bufferedBytes -= bytes;
      this.exceeded(
        this.limits.maxBufferedBytes === this.limits.maxMemoryBytes
          ? "maxMemoryBytes"
          : "maxBufferedBytes",
        attempted,
        "E2BIG",
        "shell buffered-byte limit exceeded",
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bufferedBytes -= bytes;
    };
  }
}
