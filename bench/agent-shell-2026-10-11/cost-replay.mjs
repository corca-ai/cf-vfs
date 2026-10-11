import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pairOrder } from "../comparison.mjs";

const [baseline, candidate, output] = process.argv.slice(2);
const engines = {};
for (const [version, directory] of [
  ["baseline", baseline],
  ["candidate", candidate],
]) {
  const root = pathToFileURL(`${resolve(directory)}/`);
  engines[version] = {
    ...(await import(new URL("src/testing/node.js", root))),
    ...(await import(new URL("demo/benchmark-suite.js", root))),
  };
}
const rows = [];
const pairs = Number(process.env.PAIRS ?? 10);
for (const credentials of ["demo", "none"]) {
  for (let pair = 0; pair < pairs; pair++) {
    const results = {};
    for (const version of pairOrder(pair)) {
      let statements = 0,
        returnedRows = 0,
        suite;
      const trace = new Map();
      const fs = new engines[version].NodeSqlFileSystem({
        now: () => 1700000000000,
        onEvent: (event) => suite?.onEvent(event),
        onStatement: (sql, count) => {
          if (process.env.TRACE === "1") {
            const row = trace.get(sql) ?? { calls: 0, rows: 0 };
            row.calls++;
            row.rows += count;
            trace.set(sql, row);
          }
          statements++;
          returnedRows += count;
        },
      });
      if (credentials === "demo") fs.setMetadata("/", { mode: 0o40777 });
      suite = new engines[version].PublicBenchmarkSuite(
        credentials === "demo" ? fs.forCredentials({ uid: 1000, gid: 1000 }) : fs,
        1700000000000,
      );
      results[version] = [];
      try {
        for (const stage of engines[version]
          .benchmarkPlan()
          .filter(
            (stage) =>
              stage.trial === 0 &&
              stage.group === "git-shell" &&
              stage.files === 100 &&
              !stage.cache,
          )) {
          trace.clear();
          statements = 0;
          returnedRows = 0;
          const result = await suite.run(stage);
          results[version].push({
            operation: stage.operation,
            statements,
            returnedRows,
            result,
            ...(process.env.TRACE === "1" &&
            ["clone-worktree", "add-changed"].includes(stage.operation)
              ? { trace: [...trace].map(([sql, counters]) => ({ sql, ...counters })) }
              : {}),
          });
          if (["add-one", "add-changed", "add-removals"].includes(stage.operation))
            await suite.validate(stage);
        }
      } finally {
        fs.close();
      }
    }
    assert.deepEqual(
      results.candidate.map((row) => row.result),
      results.baseline.map((row) => row.result),
    );
    rows.push({ credentials, pair, ...results });
  }
}
await writeFile(
  output,
  JSON.stringify({ fsClock: 1700000000000, identityTime: 1700000000000, pairs, rows }, null, 2),
);
console.log(
  "Fixed-clock Git shell cost replay completed; inspect both versions, including differences",
);
