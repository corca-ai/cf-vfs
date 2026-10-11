import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { FsMetadataIndex } from "../../dist/fs/metadata.js";
import { NodeSqlFileSystem } from "../../dist/testing/node.js";
import { pairedRatio, pairOrder } from "../comparison.mjs";

const rows = [];
for (const credentials of [false, true]) {
  const cost = { statements: 0, returnedRows: 0 };
  const fs = new NodeSqlFileSystem({
    recordChanges: true,
    onStatement: (_q, n) => {
      cost.statements++;
      cost.returnedRows += n;
    },
  });
  fs.mkdir("/work");
  await fs.writeFiles(
    Array.from({ length: 1000 }, (_, i) => ({ path: `/work/f${i}`, body: "hello" })),
  );
  const view = credentials ? fs.forCredentials({ uid: 1000, gid: 1000 }) : fs;
  const paths = Array.from({ length: 1000 }, (_, i) => `/work/f${i}`);
  for (let pair = -2; pair < 20; pair++)
    for (const version of pairOrder(pair)) {
      cost.statements = 0;
      cost.returnedRows = 0;
      const start = performance.now();
      const result =
        version === "baseline"
          ? paths.map((path) => ({ stat: view.lstat(path) }))
          : view.statMany(paths, { follow: false });
      const ms = performance.now() - start;
      assert.equal(result.length, 1000);
      assert.equal(
        result.every((r) => r.stat?.sizeBytes === 5),
        true,
      );
      if (pair >= 0) rows.push({ operation: "metadata", credentials, pair, version, ms, ...cost });
    }
  if (!credentials) {
    const index = new FsMetadataIndex(fs);
    index.refresh();
    for (let pair = -2; pair < 20; pair++) {
      await fs.writeFile("/work/f0", `change${pair}`);
      for (const version of pairOrder(pair)) {
        cost.statements = 0;
        cost.returnedRows = 0;
        const start = performance.now();
        const result =
          version === "baseline" ? fs.find({ path: "/", includeRoot: true }) : index.refresh();
        const ms = performance.now() - start;
        assert.ok(result);
        if (pair >= 0)
          rows.push({ operation: "incremental", credentials, pair, version, ms, ...cost });
      }
      assert.deepEqual(
        index.snapshot().sort((a, b) => a.path.localeCompare(b.path)),
        fs.find({ path: "/", includeRoot: true }).sort((a, b) => a.path.localeCompare(b.path)),
      );
    }
  }
  fs.close();
}
const summary = [];
for (const operation of ["metadata", "incremental"])
  for (const credentials of [false, true]) {
    const selected = rows.filter((r) => r.operation === operation && r.credentials === credentials);
    if (!selected.length) continue;
    const b = selected.filter((r) => r.version === "baseline"),
      c = selected.filter((r) => r.version === "candidate");
    summary.push({
      operation,
      credentials,
      ratio: pairedRatio(
        b.map((r) => r.ms),
        c.map((r) => r.ms),
      ),
      baselineCost: b[0],
      candidateCost: c[0],
    });
  }
await writeFile(
  new URL("./local.json", import.meta.url),
  `${JSON.stringify({ rows, summary }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
