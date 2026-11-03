import { DurableObject } from "cloudflare:workers";

/**
 * What every public terminal room together may spend in a UTC day, in
 * millionths of a dollar: about $20 a month. Rooms are per country, so a cap
 * per room would multiply by the number of countries; this one does not.
 */
export const DAILY_DEMO_BUDGET = 660_000;

/** The one object every room takes its spending from, in blocks. */
export const DEMO_BUDGET_NAME = "global-v1";

interface Ledger {
  day: string;
  spent: number;
}

/**
 * The public demo's daily budget, shared by every terminal room.
 *
 * A room reserves a block when it has none left and spends it locally, so
 * this object sees one call per block rather than one per command. A block a
 * room is evicted with is lost, which errs towards spending less.
 */
export class DemoBudget extends DurableObject {
  /** Grants up to `units` of today's budget; less, or none, once it runs out. */
  async reserve(day: string, units: number): Promise<number> {
    const ledger = (await this.ctx.storage.get<Ledger>("ledger")) ?? { day, spent: 0 };
    const today = ledger.day === day ? ledger : { day, spent: 0 };
    const granted = Math.max(0, Math.min(units, DAILY_DEMO_BUDGET - today.spent));
    if (granted > 0) await this.ctx.storage.put("ledger", { day, spent: today.spent + granted });
    return granted;
  }
}
