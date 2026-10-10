import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { measurePairs } from "./comparison.mjs";

if (!process.env.EXTENSION_BASELINE)
  throw new Error("EXTENSION_BASELINE must name a baseline dist directory");
const libraries = {
  baseline: pathToFileURL(`${resolve(process.env.EXTENSION_BASELINE)}/`),
  candidate: new URL("../dist/", import.meta.url),
};
const workloads = [
  { name: "single-8KiB", count: 1, size: 8192, repeats: 500, single: true },
  { name: "single-8MiB", count: 1, size: 8 * 1024 * 1024, repeats: 20, single: true },
  { name: "unchanged-8KiB", count: 1, size: 8192, repeats: 500, single: true, skip: true },
  {
    name: "unchanged-8MiB",
    count: 1,
    size: 8 * 1024 * 1024,
    repeats: 20,
    single: true,
    skip: true,
  },
  { name: "batch-100-8KiB", count: 100, size: 8192, repeats: 10 },
  { name: "batch-3-1MiB", count: 3, size: 1024 * 1024, repeats: 30 },
  { name: "batch-100-bytes", count: 100, size: 8192, repeats: 10, bytes: true },
];
const suites = {};
const results = [];
const warmups = 5;
const samples = 15;
for (const [version, library] of Object.entries(libraries)) {
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", library));
  let vfs;
  let workload;
  let statements = 0;
  let rows = 0;
  let entries;
  suites[version] = {
    async prepare(name) {
      vfs?.close();
      workload = workloads.find((item) => item.name === name);
      vfs = new NodeSqlFileSystem({
        onStatement: (_query, returned) => {
          statements++;
          rows += returned;
        },
      });
      vfs.mkdir("/batch");
      const body = workload.bytes
        ? new Uint8Array(workload.size).fill(65)
        : "A".repeat(workload.size);
      entries = Array.from({ length: workload.count }, (_, i) => ({ path: `/batch/f${i}`, body }));
      await vfs.writeFiles(entries);
      if (workload.skip)
        await vfs.writeFile(entries[0].path, entries[0].body, { skipIfUnchanged: true });
    },
    async run() {
      statements = 0;
      rows = 0;
      let written;
      for (let repeat = 0; repeat < workload.repeats; repeat++) {
        written = workload.single
          ? [
              await vfs.writeFile(entries[0].path, entries[0].body, {
                skipIfUnchanged: workload.skip,
              }),
            ]
          : await vfs.writeFiles(entries);
      }
      assert.equal(written.length, workload.count);
      assert.ok(written.every((result) => result.sizeBytes === workload.size));
      return {
        statements,
        returnedRows: rows,
        bytes: workload.count * workload.size * workload.repeats,
      };
    },
    close() {
      vfs?.close();
    },
  };
}
try {
  for (const workload of workloads) {
    const result = await measurePairs(suites, workload.name, warmups, samples);
    results.push({ ...workload, ...result });
    console.log(
      JSON.stringify({
        name: result.name,
        baseline: result.baselineMs.median,
        candidate: result.candidateMs.median,
        ratio: result.ratio,
      }),
    );
  }
} finally {
  for (const suite of Object.values(suites)) suite.close();
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const files = ["buffering.js", "digest.js", "sql-content-base.js", "sql-write-base.js"];
const report = {
  node: process.version,
  cpu: cpus()[0]?.model,
  warmups,
  samples,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDiff: execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" }),
  compiledHashes: Object.fromEntries(
    Object.entries(libraries).map(([variant, library]) => [
      variant,
      Object.fromEntries(files.map((file) => [file, sha(new URL(`vfs/${file}`, library))])),
    ]),
  ),
  results,
};
writeFileSync(
  process.env.EXTENSION_OUTPUT ?? new URL("./extension-write-results.json", import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
);
