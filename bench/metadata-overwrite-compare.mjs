import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [baselineDir, candidateDir, output = "bench/metadata-overwrite-results.json"] =
  process.argv.slice(2);
if (!baselineDir || !candidateDir)
  throw new Error("Usage: metadata-overwrite-compare.mjs BASELINE_DIST CANDIDATE_DIST [OUTPUT]");
async function library(directory) {
  const base = pathToFileURL(`${path.resolve(directory)}/`);
  const [{ NodeSqlFileSystem }, { FsMetadataCache }] = await Promise.all([
    import(new URL("testing/node.js", base)),
    import(new URL("fs/metadata.js", base)),
  ]);
  return { NodeSqlFileSystem, FsMetadataCache };
}
const libraries = { baseline: await library(baselineDir), candidate: await library(candidateDir) };
const samples = [];
for (const count of [1000, 4096]) {
  for (let trial = -3; trial < 21; trial += 1) {
    for (const variant of trial % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
      const { NodeSqlFileSystem, FsMetadataCache } = libraries[variant];
      const cache = new FsMetadataCache(4096);
      let statements = 0;
      const vfs = new NodeSqlFileSystem({
        onEvent: cache.onEvent,
        onStatement: () => {
          statements += 1;
        },
      });
      try {
        vfs.mkdir("/files");
        await vfs.writeFiles(
          Array.from({ length: count }, (_, index) => ({ path: `/files/f${index}`, body: "old" })),
        );
        cache.list(vfs, "/files");
        await vfs.writeFile("/files/f0", "changed");
        statements = 0;
        const started = performance.now();
        let bytes = 0;
        for (let index = 0; index < count; index += 1)
          bytes += cache.stat(vfs, `/files/f${index}`, false).sizeBytes;
        const ms = performance.now() - started;
        assert.equal(bytes, (count - 1) * 3 + 7);
        if (trial >= 0) samples.push({ count, trial, variant, ms, statements });
      } finally {
        vfs.close();
      }
    }
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [1000, 4096].map((count) => {
  const rows = samples.filter((row) => row.count === count);
  const baseline = rows.filter((row) => row.variant === "baseline");
  const candidate = rows.filter((row) => row.variant === "candidate");
  return {
    count,
    baselineMs: median(baseline.map((row) => row.ms)),
    candidateMs: median(candidate.map((row) => row.ms)),
    pairedRatio: median(
      candidate.map((row) => row.ms / baseline.find((other) => other.trial === row.trial).ms),
    ),
    baselineStatements: median(baseline.map((row) => row.statements)),
    candidateStatements: median(candidate.map((row) => row.statements)),
  };
});
writeFileSync(
  output,
  `${JSON.stringify({ node: process.version, baselineDir, candidateDir, warmups: 3, trials: 21, methodology: "Warm metadata via list, overwrite one existing inline file, time lstat for every file; SQL observation is the same integer increment on both versions.", summary, samples }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
