import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [output] = process.argv.slice(2),
  url = process.env.EVALUATION_URL ?? "https://cf-vfs-workspace-evaluation.donghun.workers.dev";
const vars = await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const room = "full-" + randomUUID(),
  rows = [],
  trials = Number(process.env.PAIRS ?? 20),
  build = process.env.CANDIDATE ?? "workspace-retention-v2";
async function request(path, version, index = 0) {
  const endpoint = new URL(path, url);
  for (const [k, v] of Object.entries({ room, version, index }))
    endpoint.searchParams.set(k, String(v));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path} ${version}: ${JSON.stringify(data)}`);
  assert.equal(data.build, build);
  return data;
}
try {
  for (let pair = -1; pair < trials; pair++) {
    const outputByVersion = {};
    for (const version of pairOrder(pair + 1)) {
      await request("/prepare-flow", version);
      await request("/flow", version, 0);
      await request("/flow", version, 1);
      const result = await request("/flow", version, 2);
      outputByVersion[version] = result.rows.map((r) => [r.phase, r.stdout]);
      for (const row of result.rows) {
        if (process.env.COST_ONLY !== "1") assert.ok(row.ms > 0);
        assert.equal(row.doBuild, build);
        if (pair >= 0) rows.push({ pair, version, colo: result.colo, ...row });
      }
    }
    assert.deepEqual(outputByVersion.baseline, outputByVersion.candidate);
    await writeFile(
      output,
      JSON.stringify(
        { build, trials, warmupCycles: 2, files: 1000, changed: 20, room, rows },
        null,
        2,
      ),
    );
    console.error("pair", pair);
  }
} finally {
  const [cleanup] = await Promise.allSettled([request("/clear", "baseline")]);
  if (cleanup.status === "rejected") console.error("Fixture cleanup failed:", cleanup.reason);
}
const summary = (
  process.env.COST_ONLY === "1" ? [] : [...new Set(rows.map((r) => r.phase)), "total"]
).map((phase) => {
  const values = (version) =>
    Array.from({ length: trials }, (_, i) =>
      rows
        .filter(
          (r) => r.version === version && r.pair === i && (phase === "total" || r.phase === phase),
        )
        .reduce((s, r) => s + r.ms, 0),
    );
  return {
    phase,
    before: distribution(values("baseline")),
    after: distribution(values("candidate")),
    ratio: pairedRatio(values("baseline"), values("candidate")),
  };
});
await writeFile(
  output,
  JSON.stringify(
    { build, trials, warmupCycles: 2, files: 1000, changed: 20, room, rows, summary },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary, null, 2));
