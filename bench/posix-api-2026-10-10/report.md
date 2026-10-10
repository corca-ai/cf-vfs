# POSIX API optimization experiments — 2026-10-10

Baseline: `6ced964`. No public API, schema, file format or cache configuration
changes. Candidate selection follows local timing, correctness and actual CF
validation; RPC timings do not imply a monetary savings percentage.

## Experiments

1. **Traversal (rejected):** aggregating ancestor permissions in SQL improved
   local deep walks, but regressed shallow walks by about 12%. A depth-based
   hybrid avoided that regression, yet CF deep-read improvement remained
   unproven (paired interval crossed 1). With 256 supplementary groups it made
   link stat 39% and deep read 45% slower locally. The existing traversal is
   retained in full. Replacing the fused canonical stat JSON query with an
   aggregate also regressed local stat about 4% and was rejected.
2. **Append:** for a verified single stored chunk whose appended result fits the
   configured width, fetch its index/byte length and concatenate the suffix in
   SQLite as a BLOB. This avoids moving/copying the old body through JavaScript.
   Existing quota, guard, permission, inode and chunk checks remain; multiple or
   differently sized stored chunks use the general path. Invalid UTF-8 and NUL
   bytes remain bytes. Ordinary small overwrite was measured as a control and
   has no new specialized path.
3. **Directories:** exact single-directory creations/removals accumulate parent
   nlink deltas in the transaction. Subtree operations and more than two changed
   parents retain the indexed recount. A wider JSON-delta experiment regressed
   a 300-file/two-parent-level batch from 14.14 to 18.60 ms (paired ratio 1.319,
   interval [1.298, 1.338]); it was rejected. The bounded fallback measures
   13.92 → 13.75 ms in a fresh paired comparison. Empty nonrecursive removal now
   uses the existing single-entry unlink path after the same ENOTEMPTY preflight,
   avoiding recursive GC/subtree bookkeeping. Parent timestamps, mutation events,
   tombstones, sticky permissions and transactional rollback remain intact.
   File and empty-directory removal write the final tombstone once instead of
   inserting then updating it. A final wide-batch control is neutral
   (paired ratio 1.010, interval [0.983, 1.030]); it is not a speedup claim.

## Local final comparison

Two warmups and ten alternating pairs; each timed call performs 300 operations.
Node v24.18.0, actual NodeSqlFileSystem, credentials uid/gid 1000. Setup and final
body/link-count validation are outside the timer. 768-byte files, plus a separate
60,000-byte tail append case. Initial exploratory fixtures contained a symlink
in every case and therefore exercised the generic resolver; accepted-local.json
and CF create it only for stat-link. Do not compare marginal times across these
fixture revisions.

| Operation | Before → after (ms) | Paired ratio [95% bootstrap interval] |
|---|---:|---:|
| stat-shallow | 2.16 → 2.19 | 1.000 [0.968, 1.057] |
| stat-deep | 4.03 → 4.00 | 1.004 [0.975, 1.026] |
| stat-link | 9.18 → 9.26 | 1.007 [0.982, 1.018] |
| stat-denied | 3.41 → 3.45 | 1.007 [0.992, 1.026] |
| read-deep | 8.08 → 8.03 | 0.986 [0.964, 1.014] |
| overwrite | 4.91 → 4.92 | 1.007 [0.998, 1.019] |
| append-small | 9.07 → 6.37 | 0.706 [0.695, 0.711] |
| append-large-tail | 24.26 → 18.69 | 0.769 [0.741, 0.779] |
| mkdir-wide | 6.61 → 5.93 | 0.896 [0.871, 0.910] |
| mkdir-deep | 11.28 → 10.59 | 0.936 [0.921, 0.952] |
| rename | 16.07 → 15.97 | 0.991 [0.980, 1.003] |
| unlink | 6.00 → 5.75 | 0.959 [0.953, 0.965] |
| rmdir | 12.95 → 5.95 | 0.458 [0.454, 0.467] |

Controls have small residual timing differences despite unchanged traversal,
overwrite and rename implementations; these are not claimed as improvements.

## CF comparison

A private authenticated Worker bundles separate complete baseline/current VFS
classes. The first run used independent Durable Objects (cf-results.json);
placement noise motivated alternating both variants in the same object with
storage cleared between fixtures (cf-colocated.json, one warmup/eight pairs).
The latter proved small append and rmdir speedups and lower mkdir SQL reads,
but did not prove deep-read acceleration. A further path control run
(cf-accepted-paths.json) after dropping aggregation again showed no significant
path improvement. Even the bounded direct-binding traversal change was dropped.
A final 256-group local control is neutral (link stat interval [0.985, 1.021],
deep read [0.993, 1.027]), confirming that the rejected regression is absent.

The final retained source is evaluated in cf-accepted.json. Front-Worker RPC
wall time excludes client network, setup and full-body validation. Operations
include assertions; separately metered profile calls are excluded from timing
statistics. Results are steady-state sequential fixtures, not cold-start or
concurrent user latency. Every call contains 300 operations. Ratios use paired
bootstrap intervals; intervals crossing 1 do not establish a latency win.
All variants use uid/gid 1000 and compatibility date 2026-07-24. Rooms are cleared
between fixtures and in finally blocks. SQL rows are actual Workers cursor
counters, not an estimate of dollar savings or CPU time.

| Operation | Before → after (ms / 300 ops) | Paired ratio [95% interval] |
|---|---:|---:|
| append-small | 294.0 → 123.5 | 0.561 [0.411, 0.636] |
| append-large-tail | 813.5 → 631.5 | 0.750 [0.702, 0.816] |
| mkdir-wide | 123.5 → 131.0 | 0.905 [0.821, 1.265] |
| unlink | 126.0 → 120.0 | 0.876 [0.854, 1.102] |
| rmdir | 152.0 → 104.0 | 0.656 [0.537, 0.699] |

Small append, large-tail append and empty rmdir establish latency improvements.
Mkdir and unlink latency remain uncertain; they are retained for verified SQL
work reduction and local improvements.

| Operation | Statements before → after | Rows read | Rows written |
|---|---:|---:|---:|
| append-small | 2400 → 2400 | 5700 → 5700 | 900 → 900 |
| append-large-tail | 2400 → 2400 | 5700 → 5700 | 900 → 900 |
| mkdir-wide | 2400 → 2400 | 49350 → 3300 | 1800 → 1800 |
| unlink | 2700 → 2400 | 4499 → 4199 | 1800 → 1500 |
| rmdir | 3899 → 2400 | 201899 → 3900 | 1200 → 1200 |

Private Worker versions: `5257f58c-6db5-42ca-ae75-295055dac04d`
(colocated hybrid), `92bcec6a-3656-48f9-9311-de756ab87a08` (path control),
`c37bca2c-2a86-47c0-9c7c-dfd6d5f96a44` (final retained source).
The private Worker is removed after evaluation; scripts can redeploy it.


## Verification

1,954 Node tests, 155 Workers tests and 46/46 native POSIX comparisons pass.
New regressions cover binary append across chunk boundaries, directory nlink
across many-parent batches/moves/copies/removals, failed-batch rollback, and deep
owner/group/root permission checks. The existing suites cover hard links, open
handles, changed stored chunk widths, symlinks, streamed-write races and quotas.
The deterministic empty-directory removal guard improves from 12 to 8 SQL
statements; ordinary file removal improves from 9 to 8. The rejected nonempty
case remains at 4. Typechecks, quality checks,
package consumers and all 12 bundle budgets pass.

## Reproduction

```sh
node bench/posix-api-2026-10-10/prepare-baseline.mjs
npm run build
node bench/posix-api-2026-10-10/local.mjs bench/posix-api-2026-10-10/baseline dist OUTPUT.json
node bench/posix-api-2026-10-10/batch-parents.mjs bench/posix-api-2026-10-10/baseline dist OUTPUT.json
npx tsc -p bench/posix-api-2026-10-10/tsconfig.json
npx wrangler deploy --config bench/posix-api-2026-10-10/wrangler.jsonc
node bench/posix-api-2026-10-10/run-cf.mjs OUTPUT.json
```

Use `COLOCATED=1 WARMUPS=1 PAIRS=8 OPERATIONS=append-small,append-large-tail,mkdir-wide,unlink,rmdir`
for the final CF run; `GROUPS_COUNT=256 OPERATIONS=stat-link,read-deep` for the
local supplementary-group control.

The generated baseline and .dev.vars are ignored. Set the private evaluation
Worker's EVALUATION_TOKEN secret separately; no credentials are checked in.
