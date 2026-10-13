import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { estimatePaired } from "../../demo/public/benchmarks/paired.js";
import { summaryMetrics, workloadKey } from "../../demo/public/benchmarks/summary.js";

const root = "bench/read-retry-2026-10-13";
for (const mode of ["unbound", "bound"]) {
  const sessions = await Promise.all(
    [1, 2, 3].map(async (i) =>
      JSON.parse(await readFile(root + "/local-final-" + mode + "-" + i + ".json", "utf8")),
    ),
  );
  const stages = sessions[0].workloads.map((w) => w.stage);
  assert.equal(stages.length, 190);
  const indexed = sessions.map(
    (s) =>
      new Map(
        s.rows
          .filter((r) => !r.profile)
          .map((r) => [r.pair + ":" + workloadKey(r.stage) + ":" + r.version, r.ms]),
      ),
  );
  function estimate(stages) {
    return estimatePaired(
      sessions.map((s, i) =>
        Array.from(
          { length: s.trials },
          (_, pair) =>
            stages.reduce((sum, stage) => {
              const key = pair + ":" + workloadKey(stage),
                a = indexed[i].get(key + ":baseline"),
                b = indexed[i].get(key + ":candidate");
              assert.ok(a > 0 && b > 0);
              return sum + Math.log(b / a);
            }, 0) / stages.length,
        ),
      ),
    );
  }
  const metrics = summaryMetrics.map((m) => ({
    id: m.id,
    estimate: estimate(stages.filter(m.includes)),
  }));
  const workloads = stages.map((stage) => ({ stage, estimate: estimate([stage]) }));
  const review = workloads.filter((w) => !w.estimate || w.estimate.value > 105);
  const allSessionFlags = sessions.flatMap((s) =>
    [...s.regressions, ...s.costRegressions].map((w) => w.stage),
  );
  const groups = [
    ...new Set(
      [...review.map((w) => w.stage), ...allSessionFlags].map(
        (s) => s.group + ":" + s.files + ":" + s.cache,
      ),
    ),
  ];
  const costs = sessions.map((s, i) => ({ session: i + 1, increases: s.costRegressions }));
  await writeFile(
    root + "/local-final-" + mode + "-aggregate.json",
    JSON.stringify({ metrics, workloads, review, groups, costs }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        mode,
        metrics,
        review: review.length,
        groups,
        costIncreases: costs.map((c) => c.increases.length),
      },
      null,
      2,
    ),
  );
}
