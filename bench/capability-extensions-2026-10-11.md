# Minimal filesystem capability experiments, 2026-10-11

Baseline: clean `58588c4d479f9d50496449050376b5b6db436d6f` (runtime public
source `6520dbe`). The user requested incremental processing over existing
capabilities and a small batch metadata capability, following
[Capabilities over features](https://wiki.g15e.com/pages/Capabilities%20over%20features):
improve composable primitives rather than adding task-specific APIs.

## Implementation

The sole new VFS method is optional `statMany(paths, { follow? })`. It accepts
at most 1,000 paths and returns ordered, per-path stat/error results. Duplicates
are retained. Ordinary canonical paths are read through bounded, 64-parameter
`VALUES` relations driving indexed point queries with `CROSS JOIN`. Paths with
POSIX operators or a namespace containing symlinks use existing resolution;
opaque metadata hydration retains the ordinary implementation after the initial
batch lookup and may therefore add reads for opaque paths. The ordinary inline
probes and full-suite profiles are not a universal read-cost guarantee for every
path class. Each path still
checks its credential view's ancestors. Nothing caches a completed permission
verdict or file body. RPC, policy roots, reserved shell paths, and the
collaborative document overlay preserve their existing checks and metadata.

The optional Git applet coalesces overlapping lstat requests during worktree
inspection. It retains no completed authorization. Unavailable capabilities
fall back to ordinary reads. Object-write phases continue to flush through the
existing writer before reading.

`FsMetadataIndex`, an optional `/fs/metadata` export, composes the existing
change feed, namespace pagination, and stat/lstat capability. Initial refresh
builds a bounded metadata index; subsequent refreshes return only updated
metadata and removed paths. The cursor advances only after all reads and capacity
checks succeed. It is a trusted **host** index over committed namespace changes,
not a user authorization cache. Credential-bound feeds remain forbidden, even
for UID 0. Document overlays must be flushed before indexing. Search, build,
and synchronization consumers can apply its deltas; this does **not** make Git
status incremental or expose the privileged feed to the demo shell.

The feature remains opt-in. `recordChanges` has its existing mutation overhead;
its cost is not hidden by comparing a feed-enabled write with a feed-disabled
write. Restarting the in-memory index requires a full initial scan. The existing
one-owner-per-database requirement applies. An audit reproduced stale feed
sequences with two independent mutating engines over one database (and duplicate
inode allocation on creation); the index cannot repair this preexisting unsupported
owner arrangement. The demo and benchmarks use one owner.

## Experiments and rejected query forms

Local baseline was captured before edits. Full-suite adoption uses the existing
146 uncached workload geometric mean; the 44 optional metadata-cache cases are
separate. Baseline and candidate run in alternating order, with fixed Git time,
one warmup and ten complete pairs. CF versions alternate within the same
Durable Object/database, with independent fixtures. Colo labels refer to the
request edge (LAX), not a claim of the physical DO location; the full worker uses
the same western North America location hint for both versions. Full native SQL
profiling is a separate pass.
Timing ratios below are candidate/baseline latency: below 1 is better. Score
improvement is `1 / ratio - 1`. Individual regression screens do not replace the
primary aggregate, per the user's acceptance policy.

The first `IN (SELECT value FROM json_each(?))` batch reduced local latency but
increased real Cloudflare billed reads from 1,000 to 3,000. Rejected. Native
32-path query-shape probes found:

| Query shape | CF rows read |
| --- | ---: |
| IN/json_each | 96 |
| unconstrained JOIN/json_each | 33,066 |
| CROSS JOIN/json_each | 64 |
| CROSS JOIN/VALUES | 32 |
| IN/bound values | 64 |
| UNION ALL at 32 terms | platform refusal |

The final VALUES implementation preserves one billed entry read per existing
ordinary path and stays below the platform's parameter limit. Full SQL strings
and raw observations are retained in the evidence directory. Preliminary CF
runs were stopped for final source cleanup and are archived as incomplete
experiments; they are not adoption evidence.

## Final evidence

**Adopted after complete local and CF evaluation.** Final graphs and source fingerprint:
[graphs](capabilities-2026-10-11/graphs.json),
[source](capabilities-2026-10-11/source-fingerprint.json).
Lossless compiled graphs are archived alongside raw results. Candidate build:
`capabilities-28720507900c8a69`.

Final local full ten-pair results (Unicode parity fix included):

| Credential view | Overall latency ratio | Bootstrap 95% CI | Interpretation |
| --- | ---: | --- | --- |
| UID/GID 1000 | 0.983895 | [0.979522, 0.993065] | score +1.64% |
| unbound | 0.994433 | [0.988621, 1.002432] | inconclusive |

One initial local timing screen, coding-small/add-partial at 100 files,
was 1.0505. An independent 20-pair repeat of its complete 14-operation group
finds 0.9977 [0.9673, 1.0380] for that operation, and no confirmed timing
regressions. The selected repeat is not a replacement full-suite score.
The final full local runs have no confirmed timing regressions. Local returned
rows are diagnostic, not Cloudflare billing; the final CF profiling pass records
native statements, rows read and rows written separately.

Final local isolated 20-pair microbenchmarks find metadata latency ratios 0.5418
(unbound) and 0.5367 (credential-bound), and incremental one-file refresh 0.00633
versus a full scan. These focused results do not substitute for the full-suite score.

Final full CF, credential-bound UID/GID 1000, ten pairs in LAX:

| Aggregate | Latency ratio | Bootstrap 95% CI | Score change |
| --- | ---: | --- | ---: |
| Primary, 146 uncached | 0.981962 | [0.965314, 0.998885] | +1.84% |
| Files, 18 uncached | 0.990537 | [0.956303, 1.051007] | inconclusive |
| Git, 128 uncached | 0.975484 | [0.969143, 0.998505] | +2.51% |
| Optional cache, 44 | 1.010162 | [0.980965, 1.037825] | inconclusive |

The primary native profile totals are 474,819 → 438,657 statements (-7.62%),
1,706,556 rows read unchanged, and 182,971 rows written unchanged. The optional
cache profile is unchanged at 72,665 statements, 247,932 reads and 44,844 writes.
No workload increases native statements, reads or writes. Seventeen workloads
cross the +5% timing screen; only cached git/status-change at 1,000 files has
its interval above one: 1.07295 [1.02113, 1.15646], median 151 → 163 ms.
An independent 20-pair repeat of all 13 operations in that cached Git group
finds status-change 0.96663 [0.88431, 0.99721], medians 180 → 174 ms. The
original regression does not reproduce in this repeat; the whole selected group
is inconclusive at 1.00469 [0.96648, 1.03782], with zero +5% timing flags, zero
confirmed timing regressions and zero native cost increases. This repeat does
not replace the complete full-suite score or erase its original flag.

Final full CF, unbound view, ten pairs:

| Aggregate | Latency ratio | Bootstrap 95% CI | Score change |
| --- | ---: | --- | ---: |
| Primary, 146 uncached | 0.948707 | [0.931558, 0.966732] | +5.41% |
| Files, 18 uncached | 0.987363 | [0.934613, 1.055610] | inconclusive |
| Git, 128 uncached | 0.946688 | [0.929187, 0.958922] | +5.63% |
| Optional cache, 44 | 0.974979 | [0.945334, 1.033568] | inconclusive |

Primary totals: 312,818 → 275,092 statements (-12.06%), 861,055 reads and
171,617 writes unchanged. Optional-cache totals are unchanged at 57,408
statements, 132,294 reads and 44,844 writes. No workload increases native
statements, reads or writes. Nineteen workloads cross +5%; three intervals
are above one: cached git/add-all at 100 files 1.06420 [1.00773, 1.12381],
cached git/log at 100 files 1.09545 [1.04545, 1.14286], and uncached files/readdir
at 1,000 files 1.11724 [1.00662, 1.14523]. Independent 20-pair complete-group repeats do not reproduce any of these
confirmed regressions. All original flags remain recorded above.

| Original flagged workload | Repeat latency ratio | Repeat 95% CI |
| --- | ---: | --- |
| git/add-all (100) | 1.032216 | [0.950000, 1.090251] |
| git/log (100) | 1.000000 | [0.900000, 1.000000] |
| files/readdir (1000) | 1.010870 | [0.892998, 1.066239] |

The selected uncached file group is 0.973232 [0.943101, 1.015551]; the selected
cached Git group is 1.002825 [0.988401, 1.038450]. Both are inconclusive. Two
workloads cross +5% in these repeats, none has its interval above one, and no
native cost increases occur. Repeats are diagnostics, not replacement full scores.

Final native CF probes, ten alternating-order samples in LAX:

- 1,000 ordinary metadata reads: 1,000 → 16 SQL statements, 1,000 entry reads
  unchanged. The first credential-bound reader pays six traversal reads in
  either order; subsequent readers reuse directory projections while still
  checking credentials. No writes in either implementation.
- One-file incremental refresh in a 1,000-file namespace: 1,005 → 4 rows read;
  3 → 2 statements, zero writes. Initial indexing and the feed's write overhead
  are outside this refresh comparison and remain explicit setup costs.
- Initial index construction: 6 statements, 5,016 native rows read, zero writes
  in all ten samples. The ordinary full namespace scan costs 1,005 reads. Initial
  construction is deliberately reported separately from steady-state refresh.
- Enabling the existing feed for a warmed single-file overwrite changes 4 → 5
  statements, keeps 7 reads, and changes 3 → 5 writes, in all ten samples.
  This index does not enable the feed automatically. Consumers already using the
  feed pay no new mutation overhead; enabling it only for indexing requires a
  separate read/write workload decision.
- Native DO clocks are not used to infer per-operation speedups. These probes
  establish billed work; full paired CF timing is measured separately.

At current published paid marginal SQLite rates, reads cost $0.001/million and
writes $1/million beyond their included allocations. Two added writes therefore
cost as much as 2,000 reads. Read-count reduction alone is **not** a general
monetary saving when enabling a previously disabled feed. Compute, storage,
allocations, mutation count and refresh frequency also matter.
[Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(checked 2026-10-11). The batch capability adds no writes and the full CF profile
preserves both total reads and writes.

A later boundary audit reproduced a batch-only lone-surrogate text-binding
mismatch. These paths now fall back to ordinary stat/lstat, and a parity test
covers both credential modes. The pre-fix graph and partial CF run are retained
separately and excluded from final adoption.

## Correctness and costs

1988 Node tests pass with four workers; 158 Workers tests pass. The default
unbounded Node test concurrency twice exceeded the existing 5-second public
benchmark test timeout; controlled concurrency passes the complete suite without
raising timeouts or changing test assertions. POSIX 46/46, typecheck, quality,
knip, execution limits, documentation, package and benchmark-protocol checks pass.
One existing unused regex-suppression warning remains.

New behavioral coverage includes individual errors/order/duplicates, malformed
and bounded batches, dot/trailing-slash/symlink resolution, permissions after
chmod, hard links, opaque metadata, RPC results, pending document overlays,
index pagination/removal/recreation/fallbacks, and failure recovery. A Workers
regression guard asserts the native 16-statement/1,000-read batch cost and a
single-file incremental refresh below ten native reads.

All 12 existing tree-shaking budgets pass without modification.

## Decision and rollout

Adopt both the optional batch capability with Git metadata coalescing and the
opt-in host index. Both credential modes improve the complete primary CF score,
with intervals below one, and preserve native reads/writes in every full-suite
workload. Individual timing screens are disclosed and their confirmed flags did
not reproduce in independent complete-group repeats. This is not a claim that
every operation improves or that the cache aggregate improves significantly.

Only `statMany` expands the VFS interface. The index composes existing host
capabilities; it does not enable the feed in the demo or make Git incremental.
The rejected query forms were not adopted. Public rollout completed on https://vfs.borca.ai/ (source `ea1b5dc`). Build
`0033f8fc1080e600aad424f09c29d9bec3574578aa97079da37f696de761407a`, deployment
`962d6ad9-b9a2-4701-a3d4-8de4563041c5`. The actual public shell passes Git
init/add/commit/status, document editing and subsequent Git status, local clone
and content checks, and DAC denial/restoration. Its unique temporary directory
was removed. This is functional verification of the collaborative demo wrapper;
it is not a separate full latency claim for that wrapper.

The public page run verifies 60,648 outputs and matches the new build and source
commit. Its three-sample descriptive latency ratios versus the deployment-before
baseline are overall 0.932086, files 0.947812, Git 0.929896 and cache 0.919246.
Thirty-nine workload medians cross +5%, with no unresolved comparisons. These
single-run observations are not the controlled adoption evidence and do not
erase individual flags. Raw public results, the compact comparison and shell
smoke are retained in the evidence directory. The benchmark page now has the
new source commit's result available for its existing history/sparklines.

Both private evaluation Workers were deleted. Completed drivers clear their
rooms in finally blocks; earlier cancelled rooms were explicitly cleared with
successful responses. Owned generated graphs and the debug tail were removed;
lossless archives and pinned reproduction instructions remain.
