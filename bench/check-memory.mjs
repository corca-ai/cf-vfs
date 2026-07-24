import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("node", ["bench/benchmarks.mjs", "--json"], {
  cwd: new URL("..", import.meta.url),
  maxBuffer: 4 * 1024 * 1024,
});
const rows = JSON.parse(stdout);
for (const name of [
  "inline-1024",
  "inline-65536",
  "inline-1048576",
  "inline-8388608",
  "inline-overwrite-1048576",
  "pipeline-1-stage",
  "pipeline-3-stage",
  "pipeline-6-stage",
  "tiny-chunk-explosion",
  "buffering-sort-long-line",
  "early-cancellation",
  "slow-consumer",
  "concurrent-shells",
  "opaque-lifecycle-gc",
  "opaque-gc-batch",
]) {
  const row = rows.find((candidate) => candidate.name === name);
  assert(row, `missing benchmark ${name}`);
  assert(Number.isFinite(row.durationMs) && row.durationMs >= 0);
  assert(Number.isSafeInteger(row.outputBytes) && row.outputBytes >= 0);
  assert.equal(row.repeats, 3);
  assert(Number.isSafeInteger(row.heapBytes) && row.heapBytes > 0);
  assert(Number.isSafeInteger(row.arrayBufferBytes) && row.arrayBufferBytes >= 0);
  assert(Number.isSafeInteger(row.externalBytes) && row.externalBytes > 0);
  assert(Number.isSafeInteger(row.rssBytes) && row.rssBytes > 0);
  assert(Number.isSafeInteger(row.peakHeapDeltaBytes) && row.peakHeapDeltaBytes >= 0);
  assert(Number.isSafeInteger(row.peakArrayBufferDeltaBytes) && row.peakArrayBufferDeltaBytes >= 0);
  assert(Number.isSafeInteger(row.peakExternalDeltaBytes) && row.peakExternalDeltaBytes >= 0);
  assert(Number.isSafeInteger(row.peakRssDeltaBytes) && row.peakRssDeltaBytes >= 0);
  assert(row.durationMs < 10_000, `${name} exceeded the 10s local regression ceiling`);
  assert.equal(row.backend, "memory");
  assert.equal(row.sqlRowsRead, null);
  assert.equal(row.sqlRowsWritten, null);
  assert.equal(row.databaseBytes, null);
  assert.equal(row.estimatedSqlRowUsd, null);
  assert(Number.isFinite(row.estimatedR2OperationUsd) && row.estimatedR2OperationUsd >= 0);
}
const opaque = rows.find((row) => row.name === "opaque-lifecycle-gc");
assert.equal(opaque.puts, 1);
assert.equal(opaque.heads, 1);
assert.equal(opaque.deleteRequests, 1);
assert.equal(opaque.deletedKeys, 1);
assert.equal(opaque.r2ClassAOperations, 1);
assert.equal(opaque.r2ClassBOperations, 1);
assert.equal(opaque.r2FreeDeleteOperations, 1);
assert.equal(opaque.estimatedR2OperationUsd, 0.00000486);
const gcBatch = rows.find((row) => row.name === "opaque-gc-batch");
assert.equal(gcBatch.puts, 64);
assert.equal(gcBatch.heads, 64);
assert.equal(gcBatch.deleteRequests, 1);
assert.equal(gcBatch.deletedKeys, 64);
assert.equal(gcBatch.r2ClassAOperations, 64);
assert.equal(gcBatch.r2ClassBOperations, 64);
assert.equal(gcBatch.r2FreeDeleteOperations, 1);
assert.equal(gcBatch.estimatedR2OperationUsd, 0.00031104);
console.log(`benchmark scenarios verified (${rows.length} measurements)`);
