import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [before, after, out] = process.argv.slice(2),
  rows = [];
for (let pair = -2; pair < 10; pair++)
  for (const version of pairOrder(pair)) {
    const { NodeSqlFileSystem } = await import(
      new URL(
        "testing/node.js",
        pathToFileURL(`${resolve(version === "baseline" ? before : after)}/`),
      )
    );
    const root = new NodeSqlFileSystem();
    try {
      root.mkdir("/work");
      root.setOwnership("/work", { uid: 1000, gid: 1000 });
      const fs = root.forCredentials({ uid: 1000, gid: 1000 });
      const entries = Array.from({ length: 300 }, (_, i) => ({
        path: `/work/p${i}/nested/file`,
        body: "x".repeat(768),
      }));
      const start = performance.now();
      await fs.writeFiles(entries, { createParents: true });
      const ms = performance.now() - start;
      assert.equal(fs.stat("/work").nlink, 302);
      assert.equal(fs.stat("/work/p5").nlink, 3);
      if (pair >= 0) rows.push({ pair, version, ms });
    } finally {
      root.close();
    }
  }
const a = rows.filter((r) => r.version === "baseline").map((r) => r.ms),
  b = rows.filter((r) => r.version === "candidate").map((r) => r.ms);
const summary = { before: distribution(a), after: distribution(b), ratio: pairedRatio(a, b) };
await writeFile(out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(summary);
