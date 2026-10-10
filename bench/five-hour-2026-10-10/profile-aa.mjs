import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workloadKey } from "../../demo/public/benchmarks/summary.js";

const [left, right, output] = process.argv.slice(2);
const engines = {};
for (const [version, root] of [
  ["baseline", left],
  ["candidate", right],
]) {
  const base = pathToFileURL(`${resolve(root)}/`);
  const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", base));
  const { PublicBenchmarkSuite, benchmarkPlan } = await import(
    new URL("demo/benchmark-suite.js", base)
  );
  const queries = new Map();
  let suite;
  const fs = new NodeSqlFileSystem({
    onEvent: (event) => suite?.onEvent(event),
    onStatement: (query, returned) => {
      const key = query.replace(/\s+/gu, " ").trim();
      const count = queries.get(key) ?? { statements: 0, returnedRows: 0 };
      count.statements++;
      count.returnedRows += returned;
      queries.set(key, count);
    },
  });
  fs.setMetadata("/", { mode: 0o40777 });
  suite = new PublicBenchmarkSuite(fs.forCredentials({ uid: 1000, gid: 1000 }), 1700000000000);
  engines[version] = {
    fs,
    suite,
    queries,
    plan: benchmarkPlan().filter((s) => s.trial === 0 && s.group === "git-shell"),
  };
}
const rows = [];
try {
  for (const stage of engines.baseline.plan) {
    let expected;
    const values = {};
    for (const version of ["baseline", "candidate"]) {
      const { suite, queries } = engines[version];
      queries.clear();
      const value = await suite.run(stage);
      expected ??= value;
      assert.deepEqual(value, expected, workloadKey(stage));
      values[version] = [...queries].map(([query, cost]) => ({ query, ...cost }));
      if (["add-one", "add-changed", "add-removals"].includes(stage.operation))
        await suite.validate(stage);
    }
    const different = values.baseline.filter((a) => {
      const b = values.candidate.find((x) => x.query === a.query);
      return !b || a.statements !== b.statements || a.returnedRows !== b.returnedRows;
    });
    rows.push({ stage, values, different });
  }
} finally {
  for (const { fs } of Object.values(engines)) fs.close();
}
await writeFile(
  output,
  `${JSON.stringify({ note: "Diagnostic identical-source SQL profile, not timing/adoption evidence", left, right, rows }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    rows.filter((r) => r.different.length).map(({ stage, different }) => ({ stage, different })),
    null,
    2,
  ),
);
