import assert from "node:assert/strict";
import { distribution, measurePairs, pairedRatio, pairOrder } from "../bench/comparison.mjs";

assert.deepEqual(pairOrder(0), ["baseline", "candidate"]);
assert.deepEqual(pairOrder(1), ["candidate", "baseline"]);
assert.deepEqual(pairOrder(2), pairOrder(0));
assert.deepEqual(distribution([4, 1, 3, 2]), { median: 2.5, p10: 1.3, p90: 3.7 });
assert.throws(() => distribution([]));
assert.throws(() => distribution([Number.NaN]));
assert.throws(() => pairedRatio([1], [1, 2]));
assert.deepEqual(pairedRatio([1, 2, 4], [2, 4, 8]), { median: 2, p10: 2, p90: 2, ci95: [2, 2] });
assert.deepEqual(pairedRatio([1, 2, 4], [1, 2, 4]).ci95, [1, 1]);
const order = [];
const suites = Object.fromEntries(
  ["baseline", "candidate"].map((version) => [
    version,
    {
      prepare: async () => {},
      run: async () => {
        order.push(version);
        return { statements: 2, returnedRows: 3 };
      },
    },
  ]),
);
const result = await measurePairs(suites, "test", 2, 4);
assert.deepEqual(order, [
  ...pairOrder(0),
  ...pairOrder(1),
  ...pairOrder(2),
  ...pairOrder(3),
  ...pairOrder(4),
  ...pairOrder(5),
]);
assert.equal(result.rawMs.baseline.length, 4);
assert.equal(result.rawMs.candidate.length, 4);
suites.candidate.run = async () => ({ statements: 3, returnedRows: 3 });
await assert.rejects(measurePairs(suites, "test", 0, 2), /structural cost changed/u);
console.log("Performance comparison protocol checks passed");
