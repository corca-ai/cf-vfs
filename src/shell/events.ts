import type { VfsErrorCode } from "../core/errors.js";
import type { ShellDerivedLimits } from "./types.js";

/** One kind of work and the units of `maxWork` it took. */
export interface ShellLimitConsumer {
  readonly consumer: string;
  readonly amount: number;
}

export type ShellEvent =
  /**
   * A bounded execution reached a limit and is about to fail: one of the five
   * `ShellLimits`, or a cap derived from them. When `maxWork` refused,
   * `breakdown` names what spent most of it.
   */
  | {
      readonly type: "shell.limit";
      readonly limit: keyof ShellDerivedLimits;
      readonly used: number;
      readonly max: number;
      readonly breakdown?: readonly ShellLimitConsumer[];
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
