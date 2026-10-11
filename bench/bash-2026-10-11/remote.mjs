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
  const url = new URL(path, "https://cf-vfs-bash-evaluation.donghun.workers.dev");
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
  assert.equal(value.build, "bash-e1d5e34f4825b460");
  return value;
}
const rows = [];
try {
  for (const [index, scenario] of scenarios.entries()) {
    const rawMs = { baseline: [], candidate: [] };
    for (let pair = -3; pair < 20; pair++) {
      for (const version of pairOrder(pair + 3)) {
        const value = await request("/shell", version, index);
        assert.equal(value.verified, 20);
        assert.equal(value.name, scenario.name);
        if (pair >= 0) rawMs[version].push(value.ms / 20);
      }
    }
    rows.push({
      name: scenario.name,
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
  new URL("./cf.json", import.meta.url),
  JSON.stringify(
    {
      pairs: 20,
      repeatsPerRequest: 20,
      timing: "caller RPC wall time divided by 20; same DO alternating versions",
      geometricRatio,
      rows,
    },
    null,
    2,
  ),
);
console.log({ geometricRatio });
