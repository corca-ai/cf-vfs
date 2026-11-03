import type { PosixRegexMeter } from "../../core/posix-regex.js";
import type { ShellBudget } from "../types.js";

/**
 * Regular-expression steps per unit of expansion work: about 10 ns each on
 * local workerd against an expansion unit's 0.1–0.6 µs, so the default
 * expansion-work limit admits several seconds of matching.
 */
const STEPS_PER_UNIT = 64;

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
