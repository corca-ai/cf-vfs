import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const fields = ["statements", "rowsRead", "rowsWritten"];
const key = (stage) => JSON.stringify([stage.group, stage.operation, stage.files, stage.cache]);
const summaries = [];
for (const input of process.argv.slice(2)) {
  const bytes = await readFile(new URL(input, import.meta.url));
  const data = JSON.parse(input.endsWith(".gz") ? gunzipSync(bytes).toString() : bytes.toString());
  assert.equal(data.workloads.length, 190, "Incomplete full comparison");
  const summary = {
    input,
    metrics: data.metrics,
    latencyFlags: data.regressions.map((r) => ({ stage: r.stage, ratio: r.ratio })),
    confirmed: data.confirmed.map((r) => ({ stage: r.stage, ratio: r.ratio })),
    costFlags: data.costRegressions.map((r) => ({ stage: r.stage, costs: r.costs })),
  };
  if (data.engine === "cloudflare-sqlite-rpc") {
    const differences = [];
    const totals = {};
    for (const version of ["baseline", "candidate"]) {
      totals[version] = {
        uncached: { statements: 0, rowsRead: 0, rowsWritten: 0 },
        cache: { statements: 0, rowsRead: 0, rowsWritten: 0 },
      };
      for (const row of data.rows.filter((r) => r.profile && r.version === version))
        for (const field of fields)
          totals[version][row.stage.cache ? "cache" : "uncached"][field] += row.sql[field];
    }
    const candidates = new Map(
      data.rows
        .filter((r) => r.version === "candidate")
        .map((r) => [`${r.profile}:${r.pair}:${key(r.stage)}`, r]),
    );
    for (const a of data.rows.filter((r) => r.version === "baseline")) {
      const b = candidates.get(`${a.profile}:${a.pair}:${key(a.stage)}`);
      assert.ok(b);
      if (fields.some((field) => a.sql[field] !== b.sql[field]))
        differences.push({
          pair: a.pair,
          profile: a.profile,
          stage: a.stage,
          baseline: a.sql,
          candidate: b.sql,
        });
    }
    summary.nativeCosts = {
      allMatchedCountersEqual: differences.length === 0,
      differences,
      profileTotals: totals,
    };
  }
  summaries.push(summary);
}
await writeFile(
  new URL("./full-summary.json", import.meta.url),
  `${JSON.stringify(summaries, null, 2)}\n`,
);
console.log(
  summaries.map((x) => ({
    input: x.input,
    metrics: x.metrics,
    flags: x.latencyFlags.length,
    confirmed: x.confirmed.length,
    costFlags: x.costFlags.length,
    nativeEqual: x.nativeCosts?.allMatchedCountersEqual,
  })),
);
