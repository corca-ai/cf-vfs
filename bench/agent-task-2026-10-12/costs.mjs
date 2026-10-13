import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { neverConnected } from "../connection-errors.mjs";

const [base, build, output] = process.argv.slice(2);
assert.ok(base?.startsWith("https://") && build && output);
const vars = await readFile(new URL("../../.dev.vars.public", import.meta.url), "utf8");
const token = vars
  .match(/^\s*PUBLIC_BENCHMARK_TOKEN\s*=\s*(.+?)\s*$/m)?.[1]
  ?.replace(/^(["'])(.*)\1$/, "$2");
assert.ok(token);
async function postCosts(group) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      return await fetch(new URL(`/costs?group=${group}`, base), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(180000),
      });
    } catch (error) {
      if (!neverConnected(error) || Date.now() >= deadline) throw error;
      console.error(`Cost group ${group}: connection failed before sending; retrying`);
      await delay(2000);
    }
  }
}
const rows = [];
let groups = 1;
for (let group = 0; group < groups; group++) {
  const response = await postCosts(group);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.reference.build, build);
  assert.equal(value.candidate.build, build);
  groups = value.groups;
  assert.equal(value.reference.rows.length, value.candidate.rows.length);
  value.reference.rows.forEach((before, index) => {
    const after = value.candidate.rows[index];
    assert.deepEqual(before.stage, after.stage);
    assert.deepEqual(before.outcome, after.outcome);
    assert.equal(before.verifiedBodies, after.verifiedBodies);
    rows.push({
      group,
      stage: before.stage,
      reference: before.costs,
      candidate: after.costs,
      verified: before.outcome.verified + before.verifiedBodies,
    });
  });
  await writeFile(
    output,
    JSON.stringify({ build, groups, completedGroups: group + 1, rows }, null, 2) + "\n",
  );
  console.error(`Native SQL group ${group + 1}/${groups}`);
}
assert.equal(rows.length, 190);
const totals = Object.fromEntries(
  ["reference", "candidate"].map((arm) => [
    arm,
    {
      statements: rows.reduce((sum, row) => sum + row[arm].statements, 0),
      rowsRead: rows.reduce((sum, row) => sum + row[arm].rowsRead, 0),
      rowsWritten: rows.reduce((sum, row) => sum + row[arm].rowsWritten, 0),
    },
  ]),
);
const increases = rows.filter((row) =>
  Object.keys(row.reference).some((key) => row.candidate[key] > row.reference[key]),
);
await writeFile(
  output,
  JSON.stringify({ build, groups, completedGroups: groups, totals, increases, rows }, null, 2) +
    "\n",
);
console.log({ totals, increases: increases.length });
