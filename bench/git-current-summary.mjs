import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { distribution, pairedRatio } from "./comparison.mjs";

const files = process.argv.slice(2);
if (files.length < 2 || files.length > 3)
  throw new Error(
    "usage: node bench/git-current-summary.mjs UNCACHED.json CACHED.json [LARGE_CACHE.json]",
  );
const summary = { datasets: [] };
const prefix = process.env.GIT_SUMMARY_PREFIX || "git-current";
for (const [index, file] of files.entries()) {
  const raw = readFileSync(file);
  const data = JSON.parse(raw);
  assert.equal(data.variant, index === 0 ? "fs" : "combined");
  const timed = data.results.filter(
    (row) => Number.isFinite(row.ms) && data.counts.includes(row.count),
  );
  const outcomes = data.results.filter((row) => row.name === "verified-outcome");
  const operations = [];
  const totals = [];
  const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const metric = (rows, field) => (data.timingOnly ? null : median(rows.map((row) => row[field])));
  for (const count of data.counts) {
    const names = [...new Set(timed.filter((row) => row.count === count).map((row) => row.name))];
    for (const name of names) {
      const rows = (kind) =>
        timed
          .filter((row) => row.count === count && row.name === name && row.kind === kind)
          .sort((a, b) => a.trial - b.trial);
      const native = rows("native");
      const vfs = rows("vfs");
      assert.equal(native.length, data.trials);
      assert.equal(vfs.length, data.trials);
      assert.ok([...native, ...vfs].every((row) => row.error === null));
      assert.deepEqual(
        native.map((row) => row.trial),
        vfs.map((row) => row.trial),
      );
      const nativeMs = native.map((row) => row.ms);
      const vfsMs = vfs.map((row) => row.ms);
      operations.push({
        count,
        name,
        nativeMs: distribution(nativeMs),
        vfsMs: distribution(vfsMs),
        ratio: pairedRatio(nativeMs, vfsMs),
        vfsSql: metric(vfs, "sql"),
        vfsReturnedRows: metric(vfs, "returnedRows"),
        nativeReadBytes: metric(native, "readBytes"),
        vfsReadBytes: metric(vfs, "readBytes"),
        nativeWriteBytes: metric(native, "writeBytes"),
        vfsWriteBytes: metric(vfs, "writeBytes"),
        nativeIndexReadBytes: metric(native, "indexReadBytes"),
        vfsIndexReadBytes: metric(vfs, "indexReadBytes"),
        nativeIndexWriteBytes: metric(native, "indexWriteBytes"),
        vfsIndexWriteBytes: metric(vfs, "indexWriteBytes"),
        rawMs: { native: nativeMs, vfs: vfsMs },
      });
    }
    for (const category of ["common-measured-workflow", "git-operations"]) {
      const sums = { native: [], vfs: [] };
      for (let trial = 0; trial < data.trials; trial++) {
        const matched = outcomes.filter((row) => row.count === count && row.trial === trial);
        assert.equal(matched.length, 2);
        assert.equal(matched[0].initialOid, matched[1].initialOid);
        assert.equal(matched[0].changedOid, matched[1].changedOid);
        for (const kind of ["native", "vfs"]) {
          const rows = timed.filter(
            (row) =>
              row.count === count &&
              row.trial === trial &&
              row.kind === kind &&
              !row.name.startsWith("add-20-") &&
              (category !== "git-operations" || row.name !== "populate"),
          );
          assert.equal(rows.length, category === "git-operations" ? 14 : 15);
          sums[kind].push(rows.reduce((sum, row) => sum + row.ms, 0));
        }
      }
      totals.push({
        count,
        category,
        nativeMs: distribution(sums.native),
        vfsMs: distribution(sums.vfs),
        ratio: pairedRatio(sums.native, sums.vfs),
        rawMs: sums,
      });
    }
  }
  const label = ["uncached", "cached-tiered", "cached-large"][index];
  writeFileSync(new URL(`./${prefix}-${label}-raw.json.gz`, import.meta.url), gzipSync(raw));
  const { results: _results, sourceDiff: _sourceDiff, ...metadata } = data;
  summary.datasets.push({
    label,
    metadata,
    operations,
    totals,
    verifiedRepositories: outcomes.length,
    verifiedFileComparisons: outcomes.reduce((sum, row) => sum + row.verifiedFiles, 0),
    compatibilityProbes: data.results.filter(
      (row) => !data.counts.includes(row.count) && row.name !== "verified-outcome",
    ),
  });
}
assert.equal(
  summary.datasets[0].metadata.protocolSha256,
  summary.datasets[1].metadata.protocolSha256,
);
assert.equal(summary.datasets[0].metadata.sourceCommit, summary.datasets[1].metadata.sourceCommit);
writeFileSync(
  new URL(`./${prefix}-summary.json`, import.meta.url),
  `${JSON.stringify(summary, null, 2)}\n`,
);
for (const dataset of summary.datasets) {
  console.log(dataset.label);
  for (const total of dataset.totals) console.log(JSON.stringify(total));
}
