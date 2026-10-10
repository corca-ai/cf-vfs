# Ten production optimization rounds — 2026-10-08

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
| 1 | Synchronous collection of materialized byte writes | Reject | binary-overwrite: 0.979 | [CF](r01-cf.json), [local](r01-local.json), [patch](r01.patch) |
| 2 | Allocation-free canonical short ASCII pathname normalization | Retain | normalize: 0.379 | [CF](r02-cf.json), [local](r02-local.json), [patch](r02.patch) |
| 3 | Combine entry and single-chunk whole body reads in one SQL statement | Retain | read: 1.052 | [CF](r03-cf-verified.json), [local](r03-local.json), [patch](r03.patch) |
| 4 | Eagerly queue a single byte-stream chunk | Reject | read: 1.005 | [CF](r04-cf.json), [local](r04-local.json), [patch](r04.patch) |
| 5 | Remove duplicate FS mkdir preflight and keep existing-directory checks outside mutation transactions | Retain | mkdir: 0.874 | [CF](r05-cf.json), [local](r05-local.json), [patch](r05.patch) |
| 6 | Reuse the parsed SQL entry common object instead of spreading its fields | Reject | read: 1.008 | [CF](r06-cf.json), [local](r06-local.json), [patch](r06.patch) |
| 7 | Reuse stat common fields instead of a second object spread | Reject | cached-stat: 1.049 | [CF](r07-cf.json), [local](r07-local.json), [patch](r07.patch) |
| 8 | Reuse a lazy non-streaming UTF-8 decoder | Reject | read: 0.988 | [CF](r08-cf.json), [local](r08-local.json), [patch](r08.patch) |
| 9 | Preserve stored chunk layout across configuration changes for overwrite and append | Retain | text-overwrite: 1.043 | [CF](r09-cf.json), [local](r09-local.json), [patch](r09.patch) |
| 10 | Fixed SQL insert for a single chunk without batch array allocations | Reject | create: 0.982 | [CF](r10-cf.json), [local](r10-local-repeat.json), [patch](r10.patch) |

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

[Raw paired samples](final-local.json), Node v24.18.0: 3 warmups and 10
measured pairs in alternating order, with the same SQL observer and fixture
for both versions. These are Node SQLite adapter CPU timings, not native FS
or production RPC measurements. Ratios use a deterministic paired bootstrap
95% interval, which describes this local experiment only.

| Workload | Before median ms | Final median ms | Paired ratio [95% interval] | SQL calls |
| --- | ---: | ---: | --- | --- |
| binary-overwrite | 18.35 | 18.36 | 1.002 [0.995, 1.017] | 7000 → 7000 |
| text-overwrite | 14.03 | 13.70 | 0.999 [0.978, 1.033] | 6000 → 6000 |
| append | 19.61 | 19.25 | 0.991 [0.956, 1.013] | 8000 → 8000 |
| read | 8.25 | 8.34 | 1.021 [1.008, 1.033] | 2000 → 1000 |
| cached-stat | 0.60 | 0.41 | 0.678 [0.609, 0.760] | 0 → 0 |
| uncached-stat | 4.46 | 4.29 | 0.975 [0.952, 0.988] | 1000 → 1000 |
| readdir | 283.42 | 282.58 | 0.997 [0.986, 1.001] | 200 → 200 |
| normalize | 14.07 | 5.46 | 0.387 [0.377, 0.397] | 0 → 0 |
| mkdir | 32.88 | 26.99 | 0.829 [0.801, 0.841] | 10002 → 9002 |
| create | 28.60 | 27.03 | 0.962 [0.900, 0.987] | 10004 → 10003 |

The unchanged-workload loop creates or accesses 1,000 files/directories;
normalization uses 100,000 calls and readdir uses 100 listings. mkdir/create
SQL counters include untimed result validation, so they are not solely
mutation costs. In particular, the creation counter's one-call reduction is
the validation read. Wall timings exclude preparation and that validation.
The benchmark is reproducible with

```sh
node bench/cf-optimization-2026-10-08/local-compare.mjs BEFORE_DIST FINAL_DIST /tmp/local.json
node bench/cf-optimization-2026-10-08/summarize.mjs
```

## Final Cloudflare confirmation

Final deployment: `ba003212-f0e3-4634-9f97-b509a6aa7845`.
Implementation fingerprint: `593a2fbb5c610670cd29eec64fd68c99cd48fefd8e80820f4bb80838d4aa8488`.
Runs: `a810e615-35bd-46fd-9257-649d3ede3ab2` and `1af40383-fb69-4d30-9f8d-d4edbfc8043e`.
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
| files/write | Off | 154 (154 / 1201 / 102) | 113 (111 / 113 / 133) | 114 (114 / 106 / 136) |
| files/read | Off | 80 (1414 / 63 / 80) | 76 (58 / 76 / 87) | 40 (40 / 38 / 58) |
| files/append | Off | 152 (152 / 1351 / 99) | 1939 (1939 / 608 / 2097) | 347 (153 / 618 / 347) |
| git/add-all | Off | 4463 (4463 / 2993 / 4516) | 2833 (2532 / 2833 / 2861) | 2619 (2415 / 3533 / 2619) |
| git/status-clean | Off | 60 (41 / 60 / 71) | 31 (31 / 41 / 27) | 41 (50 / 41 / 28) |
| git/checkout-main | Off | 163 (141 / 163 / 1705) | 106 (106 / 136 / 105) | 124 (121 / 128 / 124) |
| files/write | On | 1333 (1333 / 1908 / 116) | 106 (83 / 106 / 133) | 120 (120 / 109 / 120) |
| files/read | On | 83 (83 / 10 / 1091) | 11 (8 / 11 / 11) | 14 (11 / 19 / 14) |
| files/append | On | 120 (1046 / 120 / 92) | 116 (116 / 967 / 89) | 1529 (1529 / 1525 / 1735) |
| git/add-all | On | 3073 (3073 / 2649 / 4107) | 2956 (2956 / 2673 / 3042) | 2672 (2672 / 2566 / 2875) |
| git/status-clean | On | 51 (51 / 46 / 73) | 37 (38 / 34 / 37) | 29 (26 / 32 / 29) |
| git/checkout-main | On | 161 (161 / 168 / 153) | 110 (110 / 95 / 112) | 108 (135 / 91 / 108) |

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

- `npm run check`: 1,845 Node tests, 131 workerd tests, POSIX comparison 46/46,
  protocol/limits/docs/package checks and all 11 bundle presets pass.
- `npm run bench:check`: 17 Node scenarios and 31 workerd benchmark assertions
  pass. The retained final source was additionally checked with `npm run bench:do`.
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
