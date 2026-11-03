import { expect, it } from "vitest";
import { addressKey, RoomBudget } from "../demo/room-budget.js";

function budget(total: number) {
  let clock = Date.UTC(2026, 10, 3, 23, 59);
  const ledger = { day: "", spent: 0, calls: 0 };
  const room = new RoomBudget(
    async (day, units) => {
      ledger.calls += 1;
      if (ledger.day !== day) Object.assign(ledger, { day, spent: 0 });
      const granted = Math.max(0, Math.min(units, total - ledger.spent));
      ledger.spent += granted;
      return granted;
    },
    () => clock,
  );
  return {
    room,
    ledger,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

it("takes the shared budget in blocks and refuses once it is spent", async () => {
  const { room, ledger } = budget(25_000);
  expect(await room.refusal("a")).toBeUndefined();
  expect(ledger.calls).toBe(1);
  room.charge(9_000, "a");
  expect(await room.refusal("b")).toBeUndefined();
  expect(ledger.calls).toBe(1);
  // Spending past the block is a debt the next reservation pays first: 20,000
  // more leaves 19,000 owed, and the 15,000 left in the pool does not cover it.
  room.charge(20_000, "b");
  expect(await room.refusal("c")).toContain("today's budget");
  expect(room.exhausted).toBe(true);
  expect(ledger.spent).toBe(25_000);
  expect(await room.refusal("c")).toContain("today's budget");
  expect(ledger.calls).toBe(2);
});

it("refuses an address that has spent its share while others go on", async () => {
  const { room } = budget(1_000_000);
  room.charge(30_000, "a");
  expect(await room.refusal("a")).toContain("your connection");
  expect(await room.refusal("b")).toBeUndefined();
});

it("starts over at the next UTC day", async () => {
  const { room, advance } = budget(10_000);
  expect(await room.refusal("a")).toBeUndefined();
  room.charge(20_000, "a");
  expect(await room.refusal("b")).toBeDefined();
  advance(60 * 1000);
  expect(room.exhausted).toBe(false);
  expect(await room.refusal("a")).toBeUndefined();
});

it("counts IPv6 visitors by their /64", () => {
  expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
  expect(addressKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  expect(addressKey("2001:0db8:0001:0002::9")).toBe("2001:db8:1:2::/64");
  expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(addressKey(null)).toBe("unknown");
});
