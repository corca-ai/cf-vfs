import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";
import { scenarios } from "./scenarios.ts";

const token = (
  await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8")
).match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const room = process.env.ROOM ?? `full-${randomUUID()}`;
const baseUrls = { baseline: process.env.BASELINE_URL, candidate: process.env.CANDIDATE_URL };
assert.ok(baseUrls.baseline && baseUrls.candidate);
const expectedBuild = (version) => `agent2-mono-${version}-v1`;
const pairs = Number(process.env.PAIRS ?? 20);
assert.ok(Number.isSafeInteger(pairs) && pairs > 0);
async function request(path, version, index) {
  const url = new URL(path, baseUrls[version]);
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
  assert.equal(value.build, expectedBuild(version));
  return value;
}
// Deployment propagation is checked before collecting any samples. A build
// change during the measured phase still fails immediately.
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    for (const version of ["baseline", "candidate"]) await request("/clear", version);
    ready = true;
    break;
  } catch (error) {
    if (error.code !== "ERR_ASSERTION") throw error;
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
    for (const version of ["baseline", "candidate"]) await request("/prepare-agent", version);
    const costs = {};
    const rawMs = { baseline: [], candidate: [] };
    for (let pair = -3; pair < pairs; pair++) {
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
    const verification = {};
    for (const version of ["baseline", "candidate"])
      verification[version] = await request("/verify-agent", version, index);
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
  for (const version of ["baseline", "candidate"]) await request("/clear", version);
}
const geometricRatio = Math.exp(
  rows.reduce((sum, row) => sum + Math.log(row.ratio.median), 0) / rows.length,
);
await writeFile(
  output,
  JSON.stringify(
    {
      builds: { baseline: expectedBuild("baseline"), candidate: expectedBuild("candidate") },
      baseUrls,
      room,
      protocol: "monomorphic-two-services-target-v1",
      warmups: 3,
      pairs,
      repeatsPerRequest: 50,
      timing:
        "caller RPC wall time divided by 50; alternating separate single-graph service actors",
      geometricRatio,
      rows,
    },
    null,
    2,
  ),
);
console.log({ geometricRatio });
