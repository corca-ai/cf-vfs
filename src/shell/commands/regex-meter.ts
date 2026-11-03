import type { PosixRegexMeter } from "../../core/posix-regex.js";
import type { ShellBudget } from "../types.js";

/**
 * Regular-expression steps per unit of expansion work: a step takes 5–10 ns
 * and a unit is costed at 0.25 µs of `maxWork`, so the default limits admit
 * some ten seconds of matching.
 */
const STEPS_PER_UNIT = 25;

/** Units charged at once, so a search per line does not call the budget each time. */
const BATCH_UNITS = 1024;

/**
 * Charges every step a command's regular expressions take to expansion work.
 * Matching is synchronous and the deadline cannot interrupt it, so a pattern
 * of many branches, many patterns, or searches that rescan a line must be
 * bounded by a count. Steps are charged in batches; at most one batch's worth
 * goes uncharged when the command ends.
 */
export function regexMeter(budget: ShellBudget): PosixRegexMeter {
  let pending = 0;
  return (steps) => {
    pending += steps;
    if (pending < STEPS_PER_UNIT * BATCH_UNITS) return;
    const units = Math.floor(pending / STEPS_PER_UNIT);
    pending -= units * STEPS_PER_UNIT;
    budget.expansionWork(units);
  };
}
