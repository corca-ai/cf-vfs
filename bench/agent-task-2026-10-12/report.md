# Permission-bound task measurement and metadata reuse experiments

## Final decision

**Delivered and deployed:** separate permission-bound agent-task timing and SQL
trends at https://vfs.borca.ai/benchmarks/ (source `9b35638`, build
`76d7d7f119cc2deb60fedbbf77ce8b45e0be3db3f0232a0692deee09e6883160`).
The exact build identifier is also in `demo/benchmark-build.ts` and saved CF
snapshots. Three task and three original-suite A/A runs calibrate this release.
Existing 190-workload reference/history and commit deduplication remain intact.

**Neither library optimization is adopted.** Public library code remains the
baseline. No FS API or schema is added.

| Experiment | CF task time vs reference | VFS overall time vs reference | Decision |
| --- | --- | --- | --- |
| `ce57add`, broad metadata reuse | −20.8%, 3 complete runs | −2.63%, 5 complete runs | Reject: repeated material stat/diff regressions |
| `201ea32`, reuse only for file reads | −18.3%, 3 complete runs | −3.88%, only 2 complete runs | Reject for adoption: 2 later full attempts failed; complete-run and confirmation gates unmet |

The second candidate's task interval is 68.81–97.08 on a reference=100 index.
It reduces task SQL from 3,560 to 1,540 statements (−56.7%), and from 8,281 to
6,261 rows read (−24.4%), with 520 rows written in both arms. These gains are
experimental, **not deployed performance claims**. SQL counts are not dollar
savings. Its independent full native-cost replay covers all 190 rows, validates
equal outcomes/bodies, and has zero per-row counter increases: total statements
332,303 → 320,084, rows read 743,361 → 723,724, writes 186,801 → 186,801.

The retry's error is `Scratch fixture was interrupted`, recorded by the existing
cross-RPC in-memory suite/token guard. The trace does not distinguish an object
restart from competing use; the first failure's underlying exception is unknown.
This is not established as a POSIX failure or a library-caused regression.
The next prerequisite for resuming this optimization is robust benchmark scratch
session lifetime and diagnostic persistence. Do not rerun until lucky or count
incomplete trials as completed runs.

Final main verification: 2,055 Node tests, 158 Workers tests, 45 performance guards,
POSIX oracle, package checks and all 12 bundle budgets pass. The rejected final
candidate separately passed 2,060 Node / 159 Workers tests and the same guards.
Both rejected source branches and full library patches are retained. Large JSON
artifacts are losslessly gzip-compressed; `evidence-manifest.json` records SHA-256
hashes. Use `gzip -dc <file>.json.gz` to inspect them. The chronology below includes
hypotheses that were later falsified; this decision is the final state.


Library baseline: b99327ffbab56ed510f107a554e0508d6b66e10d (no library changes
since 4e449bb). The new task fixture is frozen independently of the 190-row
public suite. Existing reference/fixture hashes remain unchanged.

## Preselected evaluation

- Three consecutive complete A/A task runs before optimization, followed by
  three runs per candidate if local whole-task and full-suite results justify CF.
- Three complete original-suite runs for baseline and accepted candidate, with
  fixed-reference and previous-version run-cluster assessment. No selective
  omission of noisy rows or runs. Every >5% flag requires independent review.
- SQL costs are a separate untimed replay. All bodies, clean state, outputs and
  commit identities must match; POSIX and bundle budgets remain adoption gates.
- Existing local task script adds SQL-query frequency diagnostics. Its raw
  baseline profile is instrumented, not an uninstrumented latency claim.

## Measurement implementation

The new endpoint `/api/benchmarks/task` uses its own coordinator/scratch object
names, protocol hash and frozen reference. It reuses durable job/TTL/history
storage. No library or FS API change is involved. The task is status, 20 edits
among 1,000 files, verification, add and commit under UID/GID 1000. Each arm is
fresh, warms two distinct-content cycles, and measures a third complete cycle
in one RPC. SQL meters are created only for a separate replay.

Local Workers integration completed 28,028 validations across seven pairs
(one warmup and six measured). This precommit integration uses the old generated
build label and is not production performance evidence. SQL medians match in
both arms: 3,560 statements, 8,281 rows read, 520 rows written.
The full check passed 2,055 Node tests, 158 Workers tests, POSIX oracle and all
12 unchanged bundle budgets. Browser smoke checks cover task UI and scripts.

## Early local experiments (not adoption evidence)

The first 30-pair task prototype reduced latency 52.71 → 43.67 ms, paired
ratio 0.82755 [0.80393, 0.84826]. After moving shared SQL read state into its
own module, a separate 30-pair task run gave 50.48 → 42.68 ms, ratio 0.84400
[0.83526, 0.85314]. The former full-suite screen overlapped test execution
in early pairs; its raw results are retained as preliminary.

The subsequent isolated 20-pair full suites did not establish an aggregate
win: bound 0.97044 [0.93929, 1.00930], unbound 0.97779 [0.94386, 1.00911].
They exposed repeated large-add timing flags. Empty Map.clear calls in every
transaction were suspected; invalidation now releases the snapshot instead.
A separate 20-pair repeat of git-shell/1000 and git-recovery/100 found no
confirmed flags and no SQL-cost increases. This does not establish causality
or replace full-suite evidence. Final full suites preselect 40 pairs per
credential mode after this source change.

The task's production A/A calibration contains three consecutive runs,
18 pairs total: index 100.967, run-cluster 95% CI [95.477, 106.773].
All 84,084 validations pass. Every arm has the same 3,560 native SQL
statements, 8,281 rows read and 520 rows written. No speedup is claimed.

A final-check attempt encountered three workerd internal errors; its next
performance-pool startup failed to load cloudflare:test-internal. Earlier
complete checks had passed 2,057 Node / 159 Workers tests. The owned local
Wrangler dev process was stopped; these infrastructure failures must be
resolved before accepting the final candidate.

## Consistent local aggregation

The legacy local harness reports the median of per-pair aggregate ratios, with
bootstrap intervals for that median. Production uses a mean of log paired
ratios. `assess-local.mjs` retains the legacy results and reanalyzes all raw
pairs with the production statistic, equal workload weights and no trimming.
It marks the interval **within one local session**, not independent sessions
or production adoption evidence. The union of legacy >5% and mean-log >5%
flags remains in the review list.

For the 40-pair EOF-read candidate, the consistent overall index is 97.432
[96.057, 98.827] bound and 97.824 [96.101, 99.578] unbound. In the bound run,
order-specific overall indices are 93.749 and 101.259; both balanced orders
remain included. A median across this bimodal mixture was especially unstable.
The raw reference/candidate arrays, old statistic and new statistic are all
preserved, rather than selecting only whichever summary favors the candidate.

The subsequent whole-body variant also consumes an existing batch snapshot
before the unbound direct-read query. Previously that path ignored the snapshot
and fetched metadata again with the body. This variant aims to cover cold
hashing/remote-tree inspection as well as EOF authorization on warm hash hits.
It still performs current access checks and materializes an immutable body
snapshot; mutations and rollback invalidate all unconsumed batch metadata.

## Final local whole-body candidate

The final 30-pair task gives marginal medians 48.773 → 41.552 ms and a paired
median ratio 0.84646 [0.83508, 0.86801]. Full 20-pair controls, analyzed with
mean log ratios, give overall indices 97.507 [95.302, 99.763] bound and 96.977
[94.938, 99.060] unbound. These are within-session intervals; CF run clusters
are still required for adoption. Cached-family intervals include 100.

Independent ten-pair repeats include all >5% mean-log or legacy timing flags,
plus cost flags, and the initially suspicious shell/recovery groups: 136 bound
and 126 unbound stages. Neither statistic confirms a >5% timing slowdown in
these repeats. Bound Node cost samples retain small increases: 5 returned rows
in direct add-all/1000, 1 in cached add-all/1000, and 5 statements/2 returned rows
in mixed clone/100. They remain review signals for native CF cost verification;
Node returned-row counts are not billed CF reads. No unbound cost increases
remain in either final full run or selected repeats.

The final full check passes 2,058 Node / 159 Workers tests, POSIX oracle and
all twelve unchanged budgets. The performance guard passes all 45 Workers
cases. The earlier workerd startup/internal failures did not recur after the
owned development server was stopped. That timing is recorded, not asserted
as a proven root cause. The source is a candidate until CF gates complete.

## CF candidate evaluation in progress

The immutable candidate is ce57add, private build
505cbaff9a82b42002c760b90a4dbbf47b0e396c6a5ecc7ce99ff7315c22b943,
deployment 59487865-0ab8-4424-a42f-cf9438b79778. Production remains at
9b35638 / build 76d7d7f119cc2deb60fedbbf77ce8b45e0be3db3f0232a0692deee09e6883160.
The private Worker uses the same compatibility flags, observability settings,
fixtures, coordinator, runner and paired protocols. Its separate cost route
runs only after the timed suites. Authentication secrets are excluded from
source and evidence.

The first task run has index 72.982 [66.467, 80.135], within-run only. Native
costs in every measured pair are 3,560 → 1,540 statements, 8,281 → 6,261 rows
read, and 520 → 520 rows written. No adoption decision is made from this run.
Absolute private-worker timings must not be compared directly with earlier
production timings: the contemporaneous reference is also slower there.
Only matched within-run ratios and run-cluster normalized comparisons are used.

## Reproduction commands

Compile baseline and candidate from separate clean source checkouts into new
output directories (the helper refuses an existing output directory):

```sh
node bench/agent-task-2026-10-12/compile.mjs BASELINE_SOURCE BASELINE_GRAPH
node bench/agent-task-2026-10-12/compile.mjs CANDIDATE_SOURCE CANDIDATE_GRAPH
PAIRS=30 node bench/agent-task-2026-10-12/local.mjs BASELINE_GRAPH CANDIDATE_GRAPH task.json
FIXED_GIT_TIME=1 PAIRS=20 WARMUPS=2 CREDENTIALS=demo node bench/three-hour-2026-10-10/local-pairs.mjs BASELINE_GRAPH CANDIDATE_GRAPH bound.json
FIXED_GIT_TIME=1 PAIRS=20 WARMUPS=2 node bench/three-hour-2026-10-10/local-pairs.mjs BASELINE_GRAPH CANDIDATE_GRAPH unbound.json
node bench/agent-task-2026-10-12/assess-local.mjs bound.json bound-assessment.json
node bench/agent-task-2026-10-12/assess-local.mjs unbound.json unbound-assessment.json
```

The local full harness starts one fresh FS per full trial; CF starts one fresh
fixture per arm/group. Thus the workloads and paired statistic match, but local
and CF fixture lifetimes are not claimed to be identical. CF results are the
production adoption evidence. Historical larger JSON files are stored as
lossless `.json.gz`; filenames inside older derived assessments predate that
archival compression.

```sh
node bench/public-remote.mjs --task --url URL --build BUILD --out task-run.json
node bench/public-remote.mjs --url URL --build BUILD --out full-run.json
node bench/agent-task-2026-10-12/costs.mjs URL BUILD costs.json
node bench/agent-task-2026-10-12/assess-cf.mjs
node bench/agent-task-2026-10-12/assess-confirmation.mjs
```

Repeat both full and task commands three times, retaining every run. The CF
analysis records the source snapshots used for previous-version normalization;
it does not modify the public history or replace the frozen reference. The
unused HTTP repeat client is retained as a rejected measurement design. Actual
confirmation uses two more complete coordinator runs (twelve new paired trials
for every workload), with between-run intervals and all five runs retained.

All three preselected private task runs are now complete: 18 measured pairs,
84,084 validations. Reference-normalized index 79.223 [64.589, 97.174],
run-cluster 95% interval. Against the three-run production A/A point, the
normalized index is 78.464 [63.491, 96.969]. Both are classified faster.
All eighteen candidate cost samples are exactly 1,540 statements / 6,261 reads /
520 writes; every reference sample is 3,560 / 8,281 / 520. This establishes the
whole-task improvement, not yet the full-suite adoption gate.

The three full baseline A/A runs give overall 100.358 [98.535, 102.215],
files 100.562 [91.753, 110.217], Git 100.330 [98.883, 101.797], cache
100.120 [98.956, 101.298]. All four include 100; no workloads are unresolved.
Thirty-nine rows have point estimates above 105, including one pointwise
slower interval (`git-shell/remove-files/1000`). These are identical library
implementations: individual pointwise flags across 190 rows are investigation
signals, not automatic proof of regression. Candidate reference and
previous-version flags are retained and independently repeated.

Source identity check: `git diff cae52554 9b35638 -- src` is empty. The sole
lockfile difference is declaring the already resolved esbuild version as a
direct development dependency. `git diff b99327f 9b35638 -- src package-lock.json`
is also empty. The baseline calibration therefore compares identical library
sources against each respective frozen reference, not a quietly newer baseline.

### Confirmation route preselection (2026-10-12 11:47 UTC)

Before runs 2–3 finish or the native cost audit is inspected, select **two
additional complete confirmation runs** (12 new alternating pairs per row)
after the original three and cost audit. The drafted `/repeat` HTTP route is
not used for timing evidence: its direct HTTP entry could place the runner
differently from the ordinary coordinator alarm path. This is a protocol risk,
not a measured claim that it did so. Complete confirmations use the unchanged
coordinator, fixture lifetime and RPC path, cover every >5% signal, and avoid
selection of only favorable groups. All five runs are retained. Report the
original three, the independent two-run confirmation, and the combined five;
the latter does not erase the original decision-stage evidence. No further
runs will be selected merely to cross a significance threshold.

### Empty-batch fast-path experiment

The first three full CF candidate runs give reference-normalized overall
97.349 [95.141, 99.608], files 102.217 [100.962, 103.488], Git 96.683
[94.297, 99.130], cache 100.670 [96.567, 104.947]. Five rows have >5%
point estimates with pointwise slower intervals; these remain pending the
preselected twelve-pair confirmation. The files-family increase is disclosed.

While CF retains immutable ce57add, a separate local checkout tests an early
return when there is no batch. This avoids checking transaction depth and two
optional Map calls on the common miss path. `fastpath-experiment.patch` records
the exact variant. Its 40-pair files-only screen compares ce57add to this
variant, **not** the original library baseline. It is not production or
adoption evidence, and does not change the running CF evaluation.

The fast-path screen does not establish an improvement: VFS/files index
99.442 [98.452, 100.441], metadata-cache index 100.195 [97.797, 102.652],
40 local alternating pairs. It is not adopted or deployed. SQL counts are
unchanged. The code, raw samples and both statistics remain available.

The full native CF cost audit completes all 190 workloads with matching
outcomes and body validation. Totals: statements 332,334 → 318,869; rows read
743,454 → 723,716; rows written 186,801 → 186,801. **No individual workload
increases any native cost counter.** The small earlier Node cost signals do
not recur in this native audit. This is a separate untimed replay, not a claim
that SQL observation was present during latency measurement.

Local environment: Node v24.18.0, macOS (darwin), arm64. The public metric's
`overall` retains its existing definition: equal-weight uncached VFS workloads;
the optional metadata-cache cohort is reported separately. All 190 rows are
retained and reviewed; the metric membership has not been changed.

Metric sizes are VFS overall 146, file operations 18, Git/coding 128, and
optional metadata cache 44. An additional all-190 diagnostic gives index
98.108 [95.528, 100.758] against the fixed reference and 97.812
[94.937, 100.773] against the previous point after three runs: uncertain.
It is disclosed alongside the unchanged VFS-only primary metric, not silently
substituted for it or claimed as a proven win. The five-run report also retains
this additional diagnostic.

## First CF candidate decision: not adopted

After all five runs, VFS overall is 97.369 [96.213, 98.540] against the
reference and 97.022 [95.523, 98.544] against the previous point. The all-190
metric is also faster: 97.947 [96.936, 98.968] / 97.651 [96.437, 98.880].
Files as a family are now uncertain, 100.829 [98.346, 103.374], and optional
cache is uncertain, 99.887 [97.454, 102.381]. The initial family slowdown did
not remain significant when all preselected evidence was included.

However, `stat-after-overwrite/100` remains 106.321 [103.684, 109.025] against
the reference, and `coding-mixed/diff-staged/100` remains 115.638
[108.448, 123.304] (previous-normalized 117.446 [106.322, 129.734]). The
previous-only remove-files signal and a new cached-write confirmation signal
are also retained in the raw assessment. The two-run confirmation's intervals
are wide; a nonsignificant two-run interval is not used to dismiss persistent
five-run evidence. **ce57add is not promoted to production.**

A second local hypothesis narrows the batch reuse to file reads instead of
probing every generic metadata lookup. Canonical batch file paths can supply
read metadata directly; noncanonical paths, trailing slashes and symlinks must
still follow normal resolution, and per-access permissions remain required.
The first candidate stays immutable in its CF Worker during this experiment.

The narrowed-read prototype's first local screen gives VFS overall 97.047
[95.381, 98.742] unbound and 97.581 [95.741, 99.457] bound, thirty pairs each.
Files are 99.660 / 99.868, both uncertain. The complete task is 49.049 → 40.694
ms, paired median ratio 0.83097 [0.82788, 0.84061]. One bound Node add-all
profile returns one additional row with unchanged statements; native cost
verification remains necessary. The first unbound screen overlaps a brief
focused unit-test invocation and is retained as exploratory only.

The full check passes 2,059 Node and 159 Workers tests but flags readFile's
cognitive complexity (16, limit 15). The direct SQL read and metadata selection
are separated into two expressions, without introducing another function call
or raising the budget. Final verification and isolated local measurements are
rerun on this exact final structure; earlier samples are not substituted for it.

### Second candidate preselected CF schedule

Before deploying the narrowed-read variant, select three complete task runs,
three full-suite runs, one separate native-cost replay of all 190 workloads,
then two complete full-suite confirmation runs (twelve additional pairs per
row). This matches the first candidate's completed evaluation. Keep the
original stable production point (9b35638) as the previous-version comparator;
ce57add remains a rejected experiment, never a silently adopted predecessor.
Raw private history still retains both experiments. Use the `readonly` label
with the assessment helpers to keep outputs separate.

The final narrowed-read structure passes 2,059 Node / 159 Workers tests,
45 Workers performance guards, POSIX oracle and all twelve existing bundle
budgets. The VFS preset is 128 bytes smaller than the first candidate.
Final local measurements run after these checks, with no test suite running
concurrently. Both 30-pair modes and their union-of-flags ten-pair repeats
must finish before the second CF deployment.

The isolated narrowed-read run gives VFS 96.438 [94.787, 98.117] unbound
and 97.559 [95.904, 99.242] bound; the task is 49.800 → 41.167 ms, paired
median ratio 0.82421 [0.81676, 0.83814]. Its independent local repeats flag
unbound Git populate/1000 (106.111 [104.651, 107.591]) and bound shell
add-removals/1000 (108.713 [100.142, 118.018]). These signals are not erased
by the improved aggregate. No second CF deployment has happened yet.

A final refinement removes redundant transaction bookkeeping: the shared batch
is cleared directly once on entry. `rememberBatch` refuses to populate it while
shared transaction depth is nonzero, so a second clear in the callback's finally
block cannot discard any new valid batch. Existing cross-owner/nested rollback
tests protect this invariant. This removes two method calls per transaction
and replaces them with one assignment; it does not change traversal generations,
transaction nesting, permission checks or filesystem APIs. The exact patch and
all earlier local results are retained. This refinement requires fresh full
checks and full local measurement before any CF evaluation.

The entry-only claim above was falsified by an added transaction-BEGIN observer
regression test: an observer can prefetch before callback depth is incremented.
The entry-only variant is rejected and was never deployed. The final refinement
retains BOTH entry and callback-exit invalidations, using direct internal field
assignments instead of method calls. All five batch-reuse tests pass, including
the previously failing permission-change observer case. The exact final source
passes the full check and performance guards. Fresh 30-pair local suites, a
30-pair task sample, and 10-pair targeted confirmations follow under readscope
filenames; earlier readonly samples remain intact.

Final second candidate: `201ea32`, branch `perf/agent-task-read-metadata`.
Full checks: 2,060 Node + 159 Workers tests, 45 performance guards, POSIX
oracle and all 12 bundle budgets pass.

Local unbound: 30 pairs, primary VFS index 96.671 [95.057, 98.313]. Order-specific indices [92.88920791906169, 100.60747560431953]. These show a substantial local order effect; do not claim independent-session confidence or use the local gain as production proof.

Local bound: 30 pairs, primary VFS index 97.502 [95.880, 99.151]. Order-specific indices [93.68525781029054, 101.47426635256578]. These show a substantial local order effect; do not claim independent-session confidence or use the local gain as production proof.

Local task: 52.483 → 43.996 ms; paired median ratio 0.84999, 95% bootstrap interval [0.8118339230130751, 0.866676645502734].

The independent ten-pair local rechecks have no mean-log >5% slowdown whose
95% interval excludes parity, in either credential mode. Minor Node SQL
flags remain explicitly investigated: add-all may return one extra row, and
clone may add five statements / two returned rows. Ten untimed query traces
show clone's five-statement increment is one BEGIN/usage read/usage update/
parent timestamp UPDATE/COMMIT, with no extra file-body work. Both arms show
this increment: totals across the ten traces match for each clone workload.
This is consistent with the existing zero-delay timer batching in
GitCheckoutWrites. A separate identical-source A/A trace also reproduces a
one-row add-all difference. These are structural diagnostics, not latency
measurements; all traces are retained. CF native counters are still required.

Second private deployment: source `201ea32`, build
`c8538e574fc9a6d7b106d02856ecce86656a79b89d5287a06465f9fb84054d52`,
deployment `73f28c17-aa68-4f3d-bf3e-9a99f6400b6a`. The preselected
three-task / five-full schedule runs sequentially via `cf-evaluate.mjs`, with
labels `cf-readonly-*`. Public production remains 9b35638 during evaluation.

The second candidate's three CF task runs complete 84,084 validations. Its
reference-normalized index is 81.73354 [68.81041, 97.08373], and its
previous-stable-point-normalized index is 80.95060 [67.55058, 97.00878].
Intervals cluster by the three complete runs, not the eighteen internal pairs.
All eighteen cost samples are 1,540 statements / 6,261 rows read / 520 rows
written versus 3,560 / 8,281 / 520: 56.7% fewer statements, 24.4% fewer rows
read, unchanged writes. This establishes a task gain, not full-suite adoption;
the original-suite schedule is still running.

The third full-suite attempt failed at approximately 53% progress. The public
API supplies only its generic failure message, not the underlying exception.
The failed snapshot is retained as `cf-readonly-full-failed-attempt.json`; the
prior two completed runs remain in history. Historical observability lookup
returned 403 with the available Wrangler OAuth permissions, so the cause is
unknown, not labeled an infrastructure failure. One unchanged-code retry is
preselected, with a live filtered error tail. A second failure blocks adoption.
The retry replaces no completed performance sample; the failed attempt remains
a separate reliability outcome. The required sample count remains five
COMPLETE full runs, not five attempts.

The retry also fails, at group index 97. Its filtered live log records
`Scratch fixture was interrupted` (run fc16ac1f-4848-435f-bf98-a7a0c27c5c5f,
deployment 73f28c17-aa68-4f3d-bf3e-9a99f6400b6a). This is the guard on
in-memory scratch suite/token continuity across per-stage RPCs. It does not
identify whether the cause was object restart or competing use, and does not
establish an optimization-caused failure. The failure is retained, not called
an infrastructure fluke. As preselected, a second failure **blocks adoption**.
Candidate 201ea32 is not merged or deployed publicly; no further timing retries
are made. The two completed full runs remain useful preliminary evidence, not
a substitute for the required three-run/full-confirmation gate.

An independent untimed native-cost replay is still collected for diagnostics,
using its own cost object and one complete group per RPC. It cannot override
the failed reliability/complete-suite gates.

Cleanup: the private evaluation Worker was deleted after saving the evidence.
Its only service consumer was itself. Public production and its R2 bucket were
not deleted. Owned temporary worktrees/compiled graphs and the copied secret
file were removed; rejected commits remain on pushed experiment branches.

The evidence commit's first remote CI run (38270884735) timed out the new
1,000-file/two-fixture task integration at Vitest's default 5,000 ms; all other
2,054 Node tests passed. The same task had passed locally and in earlier CI.
Its own timeout is now explicitly 20,000 ms. Assertions, data size, runtime
implementation, benchmark timing and performance gates are unchanged. The
focused three-test suite passes after this correction. This CI test timeout
is separate from the CF scratch-fixture interruption recorded above.
