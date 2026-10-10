import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("./", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const rounds = read("rounds.json");
assert.equal(rounds.length, 10);
const result = (name) => {
  const value = read(name).result;
  assert.equal(value.rows.length, 88);
  assert.equal(value.verified, 18096);
  assert.ok(value.rows.every((row) => row.samplesMs.length === 3));
  return value;
};
const baseline = result("baseline.json");
const final = result("final.json");
const repeat = result("final-repeat.json");
assert.equal(final.buildId, repeat.buildId);
assert.equal(final.deploymentId, repeat.deploymentId);
const local = read("final-local.json");
const targets = [
  "binary-overwrite",
  "normalize",
  "read",
  "read",
  "mkdir",
  "read",
  "cached-stat",
  "read",
  "text-overwrite",
  "create",
];
const decisions = rounds.map((round, index) => {
  const measurement = read(round.local).results.find((row) => row.operation === targets[index]);
  result(round.result);
  const number = String(round.round).padStart(2, "0");
  return `| ${round.round} | ${round.candidate} | ${round.retained ? "Retain" : "Reject"} | ${targets[index]}: ${measurement.ratio.median.toFixed(3)} | [CF](${round.result}), [local](${round.local}), [patch](r${number}.patch) |`;
});
const localRows = local.results.map(
  (row) =>
    `| ${row.operation} | ${row.before.median.toFixed(2)} | ${row.after.median.toFixed(2)} | ${row.ratio.median.toFixed(3)} [${row.ratio.ci95.map((n) => n.toFixed(3)).join(", ")}] | ${row.statements.baseline[0]} → ${row.statements.candidate[0]} |`,
);
const key = (row) => `${row.group}/${row.operation}/${row.files}/${row.cache}`;
const indexes = [final, repeat].map((value) => new Map(value.rows.map((row) => [key(row), row])));
const cfRows = baseline.rows
  .filter(
    (row) =>
      row.files === 1000 &&
      ["write", "read", "append", "add-all", "status-clean", "checkout-main"].includes(
        row.operation,
      ),
  )
  .map((row) => {
    const values = [row, ...indexes.map((index) => index.get(key(row)))];
    assert.ok(values.every(Boolean));
    const cells = values.map((value) => `${value.medianMs} (${value.samplesMs.join(" / ")})`);
    return `| ${row.group}/${row.operation} | ${row.cache ? "On" : "Off"} | ${cells.join(" | ")} |`;
  });
const text = `# Ten production optimization rounds — 2026-10-08

Ten candidates were deployed and measured on the actual Cloudflare Worker and
SQLite Durable Object at [the public page](https://vfs.borca.ai/benchmarks/).
Three performance changes and one data correctness fix are retained; six
candidates were rejected and removed from the final library. No filesystem
API was added. Every candidate run completed 18,096 assertions.

## Decisions

Local ratios are candidate/baseline; smaller is faster. The local workload
column identifies the selected measurement, not a whole-application speedup.
[The ledger](rounds.json) specifies each candidate's accepted baseline and
decision. Rejected patches remain as experiment artifacts only.

| Round | Candidate | Decision | Selected local paired ratio | Evidence |
| --- | --- | --- | --- | --- |
${decisions.join("\n")}

Round 2 preserves UTF-8 byte limits, NUL rejection, dot traversal and trailing
directory intent. Only short canonical absolute ASCII paths use the fast path.
Round 3 combines entry and small whole-file body retrieval into one SQL
statement. Credential views, symlinks, ranges, multi-chunk bodies and legacy
layouts retain their existing paths. An extra-tail check preserves corruption
detection. Whole reads still own immutable snapshots and respect byte budgets.
Round 5 removes the FS adapter's duplicate mkdir lookup and moves an existing
directory check outside the mutation transaction; actual creation remains
transactional, with permission, mode and quota checks intact.

Round 9 fixes four reproduced failures when reopening storage with a different
chunk size. Full overwrite previously left old tail chunks; append inferred
the tail using the current configuration and could report EIO. Overwrite now
uses the actual stored last chunk, and append recovers the stored width only
when the current-width check fails. Tests cover changed widths in both
directions, previous read snapshots, inode identity and hard links. This is a
correctness fix, not a claimed speed improvement: its isolated local overwrite
comparison costs approximately 2.5–4.3% more CPU. SQL call counts remain equal.

Round 10 creation ratios in two local comparisons were 0.972 and 0.982, with
both confidence intervals including 1. Its quiet append comparison improved,
but CF append medians worsened in both cache modes and other workloads were
mixed. The candidate was removed. Round 8's decoder change was also removed;
BOM, malformed UTF-8 and concurrent read coverage is retained.

## Final local comparison

[Raw paired samples](final-local.json), Node ${local.node}: 3 warmups and 10
measured pairs in alternating order, with the same SQL observer and fixture
for both versions. These are Node SQLite adapter CPU timings, not native FS
or production RPC measurements. Ratios use a deterministic paired bootstrap
95% interval, which describes this local experiment only.

| Workload | Before median ms | Final median ms | Paired ratio [95% interval] | SQL calls |
| --- | ---: | ---: | --- | --- |
${localRows.join("\n")}

The unchanged-workload loop creates or accesses 1,000 files/directories;
normalization uses 100,000 calls and readdir uses 100 listings. mkdir/create
SQL counters include untimed result validation, so they are not solely
mutation costs. In particular, the creation counter's one-call reduction is
the validation read. Wall timings exclude preparation and that validation.
The benchmark is reproducible with

\`\`\`sh
node bench/cf-optimization-2026-10-08/local-compare.mjs BEFORE_DIST FINAL_DIST /tmp/local.json
node bench/cf-optimization-2026-10-08/summarize.mjs
\`\`\`

## Final Cloudflare confirmation

Final deployment: \`${final.deploymentId}\`.
Implementation fingerprint: \`${final.buildId}\`.
Runs: \`${final.runId}\` and \`${repeat.runId}\`.
Each confirmation contains 88 rows and 18,096 assertions. All 100/1,000-file
results are in [baseline](baseline.json), [final](final.json) and
[final repeat](final-repeat.json).

Selected 1,000-file workloads below show median milliseconds and all three raw
samples in parentheses, in execution order. They are descriptive observations;
these sequential CF runs are not randomized paired trials or a production
confidence interval. Large scheduling/dispatch outliers remain visible. The
cached baseline write median in particular is inflated by slow samples.

| Operation | Metadata cache | Initial median (samples) | Final median (samples) | Repeat median (samples) |
| --- | --- | --- | --- | --- |
${cfRows.join("\n")}

Append has worse final medians and is not an established improvement. The
same retained implementation produced 131/146 ms (cache off/on) in round 9,
1,939/116 ms in the first confirmation and 347/1,529 ms in the second. The
local append comparison has no clear CPU change. These production stalls
remain unexplained; the results do not establish a universal improvement or
rule out workload-specific regressions.

Measurement is Worker-to-DO RPC wall time, including dispatch and operation
assertions. Full-body validation and teardown are excluded. The workload is
unchanged: one warmup, three samples, Git add batches of 32, isomorphic-git
1.43.1 and SQLite inline bodies. There is no R2, native filesystem, native Git
or external Git network comparison. Recorded colo is the request location,
not proof of the Durable Object's location. CF gains must not be represented
as universal CPU speedups; the local whole-read CPU result is slightly slower.

## Correctness, storage cost and deployment integrity

- \`npm run check\`: 1,845 Node tests, 131 workerd tests, POSIX comparison 46/46,
  protocol/limits/docs/package checks and all 11 bundle presets pass.
- \`npm run bench:check\`: 17 Node scenarios and 31 workerd benchmark assertions
  pass. The retained final source was additionally checked with \`npm run bench:do\`.
- Small-BLOB benchmark: 512 reads now use 512 instead of 1,024 SQL calls;
  measured billed rows are 1,536 instead of 1,535. The text-processing fixture
  changes from 2 calls/2 rows to 1 call/3 rows because of the indexed tail
  guard. Existing-file overwrite remains 3 calls, but the actual tail check
  changes the point fixture from 5 to 6 rows read. Read-plus-edit changes
  from 4 calls/6 rows to 3 calls/8 rows. Exact guards were updated to these
  measured costs, including alias writes; none uses a permissive ceiling.
- An early round-3 result had stale deployment metadata and is
  [excluded](r03-cf.json). The replacement is [fingerprint verified](r03-cf-verified.json).
  Baseline and rounds 1–2 predate source fingerprints and rely on their
  deployment metadata. All later rounds and final confirmations verify the
  Worker and DO source fingerprint before starting and throughout the run.
- Deployment propagation sometimes took several minutes. The developer CLI
  retries for up to ten minutes rather than recording a mismatched build.
  New checkpoints capture the requesting Worker's version, not a resident
  DO's potentially stale version metadata. Mixed implementations cannot publish
  a successful result.
- Public GET remains read-only. Public requests use the VFS result file mtime
  and the existing ten-minute TTL; authenticated developer evaluation can
  request a fresh run immediately, while concurrent requests share a run.

Public page desktop/mobile rendering, existing shell execution, live build
identity and public cache reuse are recorded in [verification](verification.json).
Deploy and repeat evaluation using [the demo workflow](../../demo/README.md#repeated-production-performance-evaluation).
`;
writeFileSync(new URL("report.md", root), text);
