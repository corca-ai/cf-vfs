import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";
import { scenarios } from "./scenarios.ts";

const token = (
  await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8")
).match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const room = `full-${randomUUID()}`;
async function request(path, version, index) {
  const url = new URL(path, "https://cf-vfs-agent-evaluation.donghun.workers.dev");
  url.searchParams.set("room", room);
  url.searchParams.set("version", version);
  if (index !== undefined) url.searchParams.set("index", index);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180000),
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  assert.equal(value.build, "agent-e7f6dd03-ten-v1");
  return value;
}
// Deployment propagation is checked before collecting any samples. A build
// change during the measured phase still fails immediately.
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    await request("/clear", "candidate");
    ready = true;
    break;
  } catch (error) {
    if (error.code !== "ERR_ASSERTION" || error.expected !== "agent-e7f6dd03-ten-v1") throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
assert.ok(ready, "Expected private Worker did not propagate");
const [output = new URL("./cf.json", import.meta.url)] = process.argv.slice(2);
const filter = new Set((process.env.SCENARIOS ?? "").split(",").filter(Boolean));
const rows = [];
try {
  for (const [index, scenario] of scenarios.entries()) {
    if (filter.size && !filter.has(scenario.name)) continue;
    await request("/prepare-agent", "candidate");
    const costs = {};
    const rawMs = { baseline: [], candidate: [] };
    for (let pair = -3; pair < 20; pair++) {
      for (const version of pairOrder(pair + 3)) {
        const value = await request("/shell", version, index);
        assert.equal(value.verified, 50);
        assert.equal(value.name, scenario.name);
        if (pair >= 0) {
          costs[version] ??= value.sql;
          assert.deepEqual(value.sql, costs[version]);
          if (costs.baseline && costs.candidate) assert.deepEqual(costs.baseline, costs.candidate);
        }
        if (pair >= 0) rawMs[version].push(value.ms / 50);
      }
    }
    const verification = await request("/verify-agent", "candidate", index);
    rows.push({
      verification,
      name: scenario.name,
      costs,
      baseline: distribution(rawMs.baseline),
      candidate: distribution(rawMs.candidate),
      ratio: pairedRatio(rawMs.baseline, rawMs.candidate),
      rawMs,
    });
    console.log(scenario.name, rows.at(-1).ratio);
  }
} finally {
  await request("/clear", "candidate");
}
const geometricRatio = Math.exp(
  rows.reduce((sum, row) => sum + Math.log(row.ratio.median), 0) / rows.length,
);
await writeFile(
  output,
  JSON.stringify(
    {
      pairs: 20,
      repeatsPerRequest: 50,
      timing: "caller RPC wall time divided by 50; same DO alternating versions",
      geometricRatio,
      rows,
    },
    null,
    2,
  ),
);
console.log({ geometricRatio });
