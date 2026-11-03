/**
 * What a room's use costs on Cloudflare, in millionths of a dollar: rows
 * written and read by its SQLite storage, and the time its Durable Object is
 * kept running by open sessions (128 MB at $12.50 per million GB-s).
 */
export const COST = {
  rowWritten: 1,
  rowRead: 0.001,
  awakeSecond: 1.6,
} as const;

/** How much of the shared budget a room takes at a time. */
const BLOCK = 10_000;
/** What one address may spend in one room in a UTC day. */
const PER_ADDRESS = 30_000;

export type Reserve = (day: string, units: number) => Promise<number>;

/**
 * One room's share of the public demo's daily budget.
 *
 * Spending is charged after the fact — a command's rows are known once it
 * has run — and a command or edit is admitted only while the room holds
 * budget and its address has not spent its daily share, so a day can overrun
 * by at most what admitted work costs. Shares per address live in memory and
 * reset if the room is evicted, which needs it to go idle first.
 */
export class RoomBudget {
  #day: string;
  #balance = 0;
  #exhausted = false;
  #addresses = new Map<string, number>();

  constructor(
    private readonly reserve: Reserve,
    private readonly now: () => number = Date.now,
  ) {
    this.#day = dayOf(now());
  }

  /** Charges `units` to the room and, when known, to the address that caused them. */
  charge(units: number, address?: string): void {
    this.#rollover();
    this.#balance -= units;
    if (address !== undefined) {
      this.#addresses.set(address, (this.#addresses.get(address) ?? 0) + units);
    }
  }

  /** Why `address` may not start work now, or `undefined` when it may. */
  async refusal(address: string): Promise<string | undefined> {
    this.#rollover();
    if ((this.#addresses.get(address) ?? 0) >= PER_ADDRESS) {
      return "your connection has used today's share of this demo; it resets at 00:00 UTC";
    }
    if (!(await this.#funded())) {
      return "the public demo has used today's budget; it resets at 00:00 UTC";
    }
    return undefined;
  }

  /** Whether the shared budget is spent for today, as far as this room knows. */
  get exhausted(): boolean {
    this.#rollover();
    return this.#exhausted;
  }

  async #funded(): Promise<boolean> {
    if (this.#balance > 0) return true;
    if (this.#exhausted) return false;
    const day = this.#day;
    const granted = await this.reserve(day, BLOCK - this.#balance);
    if (day !== this.#day) return this.#funded();
    this.#balance += granted;
    if (this.#balance <= 0) this.#exhausted = true;
    return this.#balance > 0;
  }

  #rollover(): void {
    const day = dayOf(this.now());
    if (day === this.#day) return;
    this.#day = day;
    this.#balance = 0;
    this.#exhausted = false;
    this.#addresses.clear();
  }
}

/**
 * The address a visitor's limits are counted by: an IPv4 address, or the /64
 * an IPv6 address belongs to, since one host holds a whole /64.
 */
export function addressKey(ip: string | null): string {
  if (ip === null || ip === "") return "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::")
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/u, ""))
    .join(":")}::/64`;
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
