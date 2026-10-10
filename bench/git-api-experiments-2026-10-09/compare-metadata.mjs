import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { NodeSqlFileSystem } = await import(
  pathToFileURL(resolve(process.argv[3] ?? "dist", "testing/node.js"))
);

import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const rows = [];
for (const credentials of [false, true]) {
  let calls = 0;
  const vfs = new NodeSqlFileSystem({ onStatement: () => calls++ });
  assert.equal(
    typeof vfs.statMany,
    "function",
    "This benchmark requires the rejected metadata experiment build.",
  );
  vfs.mkdir("/repo");
  for (let n = 0; n < 1000; n++) await vfs.writeFile(`/repo/f${n}`, "x");
  const fs = credentials ? vfs.forCredentials({ uid: 1000, gid: 1000 }) : vfs;
  const paths = Array.from({ length: 1000 }, (_, n) => `/repo/f${n}`);
  for (let trial = -3; trial < 20; trial++)
    for (const version of pairOrder(trial)) {
      calls = 0;
      const start = performance.now();
      const stats =
        version === "baseline"
          ? paths.map((path) => fs.lstat(path))
          : fs.statMany(paths, { follow: false });
      const ms = performance.now() - start;
      assert.equal(stats.length, 1000);
      assert.ok(stats.every((s, n) => s.path === paths[n] && s.sizeBytes === 1));
      if (trial >= 0) rows.push({ credentials, version, trial, ms, calls });
    }
  vfs.close();
}
const summary = [false, true].map((credentials) => {
  const a = rows.filter((r) => r.credentials === credentials && r.version === "baseline");
  const b = rows.filter((r) => r.credentials === credentials && r.version === "candidate");
  return {
    credentials,
    baseline: distribution(a.map((r) => r.ms)),
    candidate: distribution(b.map((r) => r.ms)),
    ratio: pairedRatio(
      a.map((r) => r.ms),
      b.map((r) => r.ms),
    ),
    calls: [a[0].calls, b[0].calls],
  };
});
await writeFile(
  process.argv[2],
  JSON.stringify(
    { node: process.version, files: 1000, warmupPairs: 3, measuredPairs: 20, rows, summary },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary, null, 2));
