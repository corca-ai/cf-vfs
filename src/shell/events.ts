import type { VfsErrorCode } from "../core/errors.js";
import type { ShellLimits } from "./types.js";

export type ShellEvent =
  /**
   * A bounded execution reached a limit and is about to fail. Covers every
   * limit `ExecutionBudget` owns — steps, commands, loop iterations, total
   * I/O, mutations, glob matches, expansion work/characters/fields, buffered
   * bytes, and the execution deadline — plus the output idle timeout.
   */
  | {
      readonly type: "shell.limit";
      readonly limit: keyof ShellLimits;
      readonly used: number;
      readonly max: number;
    }
  /** One utility or function finished. High volume; sample if needed. */
  | {
      readonly type: "shell.command";
      readonly name: string;
      readonly exitCode: number;
    }
  /**
   * One submitted source unit finished. `failureCode` is present when the unit
   * ended through a limit, deadline, cancellation, or invariant failure rather
   * than an ordinary non-zero status.
   */
  | {
      readonly type: "shell.execution";
      readonly exitCode: number;
      readonly durationMs: number;
      readonly failureCode?: VfsErrorCode;
    };

export type ShellEventSink = (event: ShellEvent) => void;

/**
 * Delivers `event` to `sink` without letting observability change behavior.
 *
 * A throwing sink must not alter an exit status, abort a pipeline, or mask the
 * error a caller is about to receive, so the failure is discarded.
 */
export function emitShellEvent(sink: ShellEventSink | undefined, event: ShellEvent): void {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    // An observer cannot influence the execution it observes.
  }
}
