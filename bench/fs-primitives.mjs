import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const library = process.env.GIT_PROBE_LIBRARY
  ? pathToFileURL(`${path.resolve(process.env.GIT_PROBE_LIBRARY)}/`)
  : new URL("../dist/", import.meta.url);
const { NodeSqlFileSystem } = await import(new URL("testing/node.js", library));
const results = [];
for (const name of ["byte-writes", "batch-create", "batch-overwrite"]) {
  for (let trial = 0; trial < 7; trial++) {
    let statements = 0,
      rows = 0;
    const vfs = new NodeSqlFileSystem({
      onStatement: (_query, n) => {
        statements++;
        rows += n;
      },
    });
    try {
      vfs.mkdir("/dir");
      const entries = Array.from({ length: 1000 }, (_, i) => ({
        path: `/dir/f${i}`,
        body: name === "byte-writes" ? new Uint8Array(800).fill(i % 255) : `file ${i}\n`,
      }));
      if (name === "batch-overwrite") await vfs.writeFiles(entries);
      statements = 0;
      rows = 0;
      const start = performance.now();
      if (name === "byte-writes")
        for (const entry of entries) await vfs.writeFile(entry.path, entry.body);
      else await vfs.writeFiles(entries);
      const ms = performance.now() - start;
      const calls = { statements, returnedRows: rows };
      assert.equal(vfs.list("/dir").length, 1000);
      results.push({ name, trial, ms, ...calls });
    } finally {
      vfs.close();
    }
  }
}
const output = {
  variant: process.env.GIT_PROBE_VARIANT || "baseline",
  node: process.version,
  results,
};
fs.writeFileSync(
  process.env.GIT_PROBE_OUTPUT || new URL("./fs-primitives-results.json", import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output));
