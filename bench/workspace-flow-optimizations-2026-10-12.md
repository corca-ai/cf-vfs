# Workspace-flow optimization, 2026-10-12

Baseline: `4be925c4c5e76f4c066407150740d0fd9e72c166`.
Evidence and replay instructions: [workspace-flow-2026-10-12](workspace-flow-2026-10-12/README.md).

The combined design changes two boundaries shared by a coding task: the lifetime
of valid directory traversal metadata, and publication of Git tree/commit objects
before a reference update. It uses existing filesystem capabilities and honors
per-path bulk eligibility. In 20 actual CF pairs of the corrected source,
complete-task latency falls **39.36%** and commit latency **83.04%**; native SQL
reads fall **25.60%** and writes **4.06%** for that task. Full-suite adoption
controls are recorded separately below. Intermediate experiments
are retained with distinct graphs and labels rather than combined into one result.

CF timings include the same SQL meter in both arms and measure Worker-to-DO
RPC wall time; the additional full-suite profile pass supplies the reported
cost totals. Local timing disables SQL observation. Instrumented private
comparisons and the post-deployment public production check are distinguished.

## Traversal reuse

An agent task crosses many command boundaries: inspect a repository, edit files,
validate the result, stage and commit. Directory access metadata belongs to the
filesystem owner, but several file-only operations discarded it as though the
directory tree had changed. The next command then repeated the same ancestor
queries. Optimizing one utility would leave this repeated work in its neighbors.

The existing transaction classification now describes whether directory
traversal metadata stays valid. Mutation-token reads, credential-bound inline
write publication that cannot create directories, and credential-bound
regular-file deletion retain the bounded projection. Append retains its existing
behavior. There are no new filesystem APIs, change-feed requirements, schema
migrations, command factories or dependencies. Ordinary Git is used throughout.

The projection contains only directory path, kind, mode, uid and gid, at most
256 entries. Every access still checks the current principal. File contents,
file metadata, mutation tokens and parent timestamps are not retained in this
projection. Directory creation/move/removal, permission changes, ordinary nested
transactions and rollback retain invalidation. Streaming write publication
revalidates permissions after collection. A batch that may create parents keeps
ordinary invalidation. A file write with `createParents` may preserve reuse only
when its captured target already exists and publication still guards that target.

## Traversal-only measurements

The additional agent task has 1,000 files across 20 directories and changes 20
files through separate non-interactive shell executions. It runs `git status`,
`sed` + redirection + temporary-file cleanup, `grep`, `git add .`, and commit.
Each cycle creates distinct content and Git objects. Output, command status and
commit identity are compared. Both arms use UID/GID 1000, fixed Git author time,
ordinary Git, and no recorded change feed. Fixture setup is excluded from this
task's timing; full-suite preparation and clone workloads are separate controls.

Trace-free local timing uses 2 warmup cycles and 30 alternating pairs. SQL
instrumentation runs separately. The local cycle medians are 53.96 → 51.35 ms;
paired latency ratio 0.96445, 95% bootstrap interval [0.94331, 0.98817]. Editing
is 5.28 → 4.29 ms (paired ratio 0.83016), verification 0.79 → 0.68 ms (0.83153).
These are end-to-end task improvements of a few percent, not a claimed
order-of-magnitude acceleration. Most remaining time is whole-repository Git
inspection and staging.

A 500-directory, 20-pair stress case exceeds traversal-cache capacity. Edit and
verify ratios remain 0.83368 and 0.83241. Whole-task ratio is 0.97150 with interval
[0.96157, 1.01407], so no overall timing change is established for that case.
The original ten unbound shell workloads have geometric ratio 1.00106; all their
intervals include 1. The two sorting stresses remain separate from that cohort.

Initial write-only and alternating-old/new-body experiments are retained as
preliminary evidence. They do not replace the final distinct-content task.
The initial credential-bound full local comparison preceded an internal field
rename; final graphs are separately rechecked, and the preliminary run is labelled.

## Traversal-only validation

Full compatibility, package, quality and bundle checks pass: 2,027 Node tests,
158 Workers tests, native POSIX comparisons and all 12 unchanged bundle budgets.
The separate performance gate passes 45 Workers performance tests. New tests
cover cross-command reuse with different principals, streamed writes and batches
after directory chmod, directory replacement/creation, and nested rollback.
The existing creation-write statement guard tightens from 13 to 12.

The following sections distinguish the traversal-only experiment from the
combined commit-publication candidate and its deployment verification.

## Additional commit-publication experiment

The deployed task profile put roughly half the cycle in commit. A separate
local prototype reused the existing loose-object writer during commit, delaying
object publication until the reference write. It added no filesystem API and
kept exact commit outputs in the task comparison. This was evaluated against
the traversal candidate, not against the original baseline.

In 30 alternating local pairs, commit ratio was 0.97812 with interval
[0.96520, 1.00365]; complete-task ratio 1.00522 [0.99774, 1.01270]. A separate
cost sample reduced commit statements 378 → 314 but increased returned rows
247 → 271. There was no established Node end-to-end latency win, so this
prototype was not adopted from those results. `commit-buffer-prototype.patch`
and both local runs retain the experiment. A follow-up local Workers probe separately measured native SQLite
costs before deciding whether a CF experiment was justified.

The final credential-bound local full comparison (10 pairs) has overall ratio
0.94802 [0.91246, 0.98438], file ratio 0.96125, Git ratio 0.94746 and separate
metadata-cache ratio 0.94641. Two >5% screening flags have intervals spanning 1;
there are no confirmed timing or SQL-cost regressions. Unbound full comparison
is neutral: overall 0.99810 [0.95688, 1.04148], no confirmed timing regressions.
One unbound clone cost flag (+5 statements, +2 returned rows) disappeared in a
separate 10-pair complete-group repeat; that repeat has no cost or confirmed
timing flags. These Node returned-row counts do not measure CF billing.

An additional deterministic differential probe compared 4,000 mixed filesystem
operation sequences across three principals with the baseline. All operation
results, errors and complete namespace metadata matched, including 1,741
successful operations. This supplements the independent native POSIX oracle.

## Traversal-only actual CF task

The final task evaluator (`workspace-retention-v2`, deployment
`408c4832-6fee-4079-95cd-67e95ad122eb`) completed 20 alternating pairs with two
untimed task cycles per arm. Each arm reconstructs its fixture in the same DO.
Measurements are Worker-to-DO RPC wall time; colo reports the request edge,
not a claim about the DO's physical location.

| Phase | Median before → after | Paired ratio | 95% interval |
| --- | ---: | ---: | --- |
| Inspect | 309 → 298 ms | 0.94796 | 0.88442–1.04632 |
| Edit | 145.5 → 132.5 ms | 0.94922 | 0.77566–0.98445 |
| Verify | 24 → 23 ms | 0.97010 | 0.73244–1.11818 |
| Stage | 417 → 402.5 ms | 1.02856 | 0.84792–1.08128 |
| Commit | 800 → 809.5 ms | 1.01226 | 0.98990–1.05009 |
| Complete task | 1725.5 → 1717.5 ms | 0.99744 | 0.94433–1.05266 |

Ratios are medians of paired ratios, not ratios of the two marginal medians.
Only editing establishes a time reduction here. The complete-task interval
includes no change: **no CF whole-task latency improvement is claimed**.

Native SQL totals per complete cycle (medians) fall from 3,854 → 3,604 statements
and 11,634 → 8,547 rows read (26.53% fewer reads). Rows written remain 542. These
are metered SQL costs, not a dollar savings estimate. All 20 paired outputs and
commit identities matched. The complete FS/Git suite remains a separate adoption
control; this task alone cannot establish its overall-score improvement.

## Traversal-only full CF credential-bound comparison

Ten alternating pairs on the same DO, one warmup pair, followed by a separate
native SQL profile; all 190 workload identities and validation counts match.

| Aggregate | Paired latency ratio | 95% interval |
| --- | ---: | --- |
| Overall, 146 uncached workloads | 0.95954 | 0.90402–1.01089 |
| Files, 18 workloads | 0.97990 | 0.89052–1.08523 |
| Git/coding/recovery, 128 workloads | 0.96572 | 0.89377–1.00631 |
| Metadata-cache variants, separate 44 | 0.98692 | 0.90109–1.11954 |

The overall point estimate improves 4.05%, but its interval includes 1; a
statistically established overall CF latency improvement is not claimed.
There are 35 >5% screening flags. Only uncached readdir at 1,000 files has a
pointwise interval above 1 (1.17324 [1.08000, 1.34022]); it needs a separate
repeat before adoption. There are **zero native SQL cost increase flags**.

Across all 190 profiled stages, native statements fall 511,260 → 472,058,
rows read 1,954,395 → 1,457,235 (25.44% fewer reads), and rows written remain
227,815. This broad cost reduction is separate from the inconclusive latency
result. No new write cost is exchanged for the retained directory metadata.


The local Workers follow-up completed 20 paired, validated task cycles. Commit
statements are 330 → 310, native reads 599 → 693, and writes 140 → 118. The
prototype trades additional reads for fewer writes; Node returned-row counts
alone did not describe that tradeoff. These cost results justify a private CF
latency experiment, kept separate from the traversal candidate's full controls.
The first attempt was interrupted by a local dev-server reload and is labelled
as incomplete; the completed 20-pair run is `workerd-commit-costs.json`.

The traversal-only unbound full CF control has overall ratio 1.02405
[0.99470, 1.07111]. All native SQL counts are identical: 332,500 statements,
993,349 reads and 216,461 writes. Ten individual >5% flags have pointwise
intervals above 1. They cannot be dismissed from the aggregate alone. The final
combined candidate is therefore evaluated with **group-paired** CF controls:
each complete workload group reconstructs the fixture for each arm, running the
two versions consecutively before proceeding to the next group. Pair order
still alternates, all 190 workload identities and validations remain, and the
146-workload aggregate retains its equal-weight geometric mean. This shortens
the separation between corresponding observations, without choosing favorable
individual samples. The old whole-suite-separated control is retained as evidence.

## Combined candidate before bulk-view fallback

The production implementation reserves commit buffers lazily, capped at 128 KiB
and available shell/backend headroom. It flushes and releases before body reads
or individual writes, and publishes objects before updating refs. It shares the
existing object writer and uses no new FS capability. Tests cover readable tree
and commit objects before ref publication, failed-batch HEAD preservation and
retry, a large index under a small shell budget, missing backend headroom, and
buffer release at read/enumeration/ref boundaries.

The pre-boundary local task comparison against the original baseline has paired
latency ratios 0.95674 overall and 0.92141 for commit. The complete credential-bound
local suite has overall ratio 0.94933 [0.91538, 0.98629]; five screening flags,
zero confirmed timing regressions, and zero SQL-cost increase flags. The
prototype and an intermediate lazy-buffer implementation remain separately
labelled and are not substituted for measurements of the corrected source.

The combined unbound local suite is neutral: 0.99976 [0.95935, 1.03687],
seven screening flags and zero confirmed timing regressions. Nine cost flags
are small returned-row increases in commit/publication paths. Total statements
fall 375,178 → 374,718 and returned rows 364,527 → 364,467; those totals do not
erase the individual flags or substitute for native CF read/write accounting.

The pre-boundary implementation passes the complete check (2,031 Node tests,
158 Workers tests, 46 native POSIX traces and all 12 unchanged bundle budgets)
and 45 Workers performance tests. A subsequent focused fifth commit-writer test
also verifies oversized-object fallback and reservation release; typecheck and
quality checks pass after that test addition. The pre-boundary emitted library's 193
JavaScript modules exactly match the measured combined graph.

## CF task before bulk-view fallback

Deployment `85b3529f-d46f-4d05-99bd-57d76e3c85f4`, build
`workspace-flow-final`, compares the original baseline with the pre-boundary combined
source. All 20 alternating pairs completed with matching command outputs and
commit IDs. Different CF runs have different absolute latency; the following
comparison uses only corresponding arms within this run.

| Phase | Median before → after | Paired ratio | 95% interval |
| --- | ---: | ---: | --- |
| Inspect | 183.5 → 193 ms | 1.05231 | 0.83670–1.10707 |
| Edit | 102.5 → 101.5 ms | 0.96603 | 0.87476–1.07249 |
| Verify | 46 → 44 ms | 0.92572 | 0.88068–1.04444 |
| Stage | 242.5 → 237 ms | 0.97254 | 0.78251–1.10195 |
| Commit | 603 → 108.5 ms | 0.18159 | 0.17322–0.19917 |
| Complete task | 1228.5 → 718.5 ms | 0.56478 | 0.54625–0.65863 |

The paired task latency reduction is **43.52%**, with **81.84%** for commit.
The other phase intervals include 1; no acceleration or regression is
established for them. A ratio of the two marginal medians is a different
statistic from the reported median paired ratio.

Every pair has identical native SQL costs: the complete task changes from
3,854 → 3,585 statements, 11,634 → 8,656 reads (**25.60% fewer**) and
542 → 520 writes (**4.06% fewer**). Commit itself changes 360 → 310 statements,
980 → 693 reads and 140 → 118 writes. These counts measure SQLite work,
not total Cloudflare charges or a dollar savings percentage.

The static-reservation prototype separately produced a 0.63194 task ratio and
0.19177 commit ratio against the traversal-only graph. That exploratory win
motivated the production implementation; it is not the final-source result.

## Full CF comparison before bulk-view fallback: credential-bound

The pre-boundary group-paired control completes ten alternating pairs, one warmup
pair, all 190 stages and a separate native SQL profile. The 146 uncached
workloads retain their equal weights; cache variants remain separate.

| Aggregate | Paired latency ratio | 95% interval |
| --- | ---: | --- |
| Overall | 0.93225 | 0.92459–0.95565 |
| Files | 0.96945 | 0.92701–0.99663 |
| Git/coding/recovery | 0.93201 | 0.91745–0.95948 |
| Metadata-cache variants | 0.94540 | 0.92265–0.98871 |

Overall latency decreases **6.77%**, with an interval supporting a 4.44–7.54%
decrease. Native totals are 511,257 → 471,826 statements,
1,657,069 → 1,159,605 reads and 198,200 → 198,155 writes; there are no individual
SQL-cost increase flags. These totals belong to the group-paired protocol and
must not be mixed with totals from the earlier whole-suite-separated protocol.

There are 33 >5% screening flags, of which three have pointwise intervals above
1: shell `add-unchanged` at 100 files (1.22078), direct-engine `commit` at 1,000
files (1.14559), and coding-small `add-rest` at 100 files (1.22932). The aggregate does not erase these flags. The unbound run of this version
was stopped when the bulk-view compatibility case was found. Its partial data
is retained, and the final implementation is evaluated against the original
baseline on the complete cohort again.


## Bulk-view compatibility correction

A filesystem can expose `writeFiles` while requiring individual I/O for a
particular path. The existing `canUseBulkOperation("write-target", path)`
contract makes that distinction. Two tests first reproduced failure when this
hint was false or absent. Object publication now rechecks all targets: an
eligible set uses the batch writer; any ineligible target makes that set use
individual writes. Actual batch failures remain fatal and never trigger a retry
that could publish a reference after failure. This also strengthens the shared
writer used by add, without adding an API.

All 2,034 Node tests, 158 Workers tests, 46 native POSIX traces, 12 unchanged
bundle budgets and 45 Workers performance tests pass for this source. Earlier
combined results are labelled `pre-boundary`; they are not claimed as
measurements of the corrected source. Both full CF cohorts are rerun with the
same group-paired protocol.


## Corrected-source local results

The final 30-pair task comparison has latency ratio 0.94910
[0.94315, 0.95913], with marginal medians 50.41 → 48.21 ms. Commit ratio is
0.92339. The credential-bound full suite has overall ratio 0.95585
[0.91705, 0.98643], four screening flags and no confirmed timing or SQL-cost
increase flags. The unbound full suite has ratio 0.99433 [0.95930, 1.03682],
six screening flags and no confirmed timing flags. Nine unbound returned-row
flags remain confined to the already identified commit/publication paths.
Actual CF reads and writes are checked separately.

## Corrected-source actual CF task

Build `workspace-flow-compatible`, deployment
`3dbf3e85-52f8-49ae-bf5c-439102671627`, graph SHA-256
`6add4e90478635cf964184f950be5d75bc7100802aed208eaae8c6174fa95724`.
Twenty alternating pairs completed with exactly matching outputs and commit IDs.

| Phase | Median before → after | Paired ratio | 95% interval |
| --- | ---: | ---: | --- |
| Inspect | 362 → 366.5 ms | 0.97299 | 0.92215–1.08557 |
| Edit | 161 → 142 ms | 0.91955 | 0.81799–1.04925 |
| Verify | 33.5 → 31 ms | 0.92197 | 0.81377–1.02986 |
| Stage | 451.5 → 470.5 ms | 1.03151 | 0.94884–1.14311 |
| Commit | 883.5 → 151 ms | 0.16957 | 0.16345–0.17806 |
| Complete task | 1903.5 → 1164 ms | 0.60640 | 0.57096–0.64486 |

The paired complete-task reduction is **39.36%** (interval 35.51–42.90%), and
commit reduction **83.04%** (82.19–83.66%). Other phase intervals include 1.
Do not compare absolute times across the pre-boundary and corrected runs:
their baseline times also differ. This table compares matching arms in one run.

Every pair again records exactly 3,854 → 3,585 statements, 11,634 → 8,656 native
reads, and 542 → 520 native writes. The eligibility correction adds no SQL work
in this ordinary workspace. Time and cost claims remain separate, and these
counts are not dollar estimates.

## Corrected-source full CF control: credential-bound

Ten alternating pairs plus one warmup pair cover all 190 stages. The primary
aggregate retains 146 equally weighted uncached workloads; 44 metadata-cache
variants remain separate. Both arms have the same SQL instrumentation.

| Aggregate | Paired latency ratio | 95% interval |
| --- | ---: | --- |
| Overall | 0.92917 | 0.90482–0.94367 |
| Files | 1.01060 | 0.95795–1.03168 |
| Git/coding/recovery | 0.92154 | 0.90283–0.93025 |
| Metadata-cache variants | 0.97841 | 0.96369–1.00372 |

The overall paired latency decrease is **7.08%** (interval 5.63–9.52%). The
file and metadata-cache intervals include 1. Native profile totals are
511,257 → 471,826 statements, 1,657,069 → 1,159,605 reads (**30.02% fewer**),
and 198,200 → 198,155 writes. No workload has a SQL-cost increase flag.

There are 28 >5% timing screening flags; two have pointwise intervals above 1:
`git-shell/pull-one/100/false` ratio 1.10257 [1.01607, 1.22236], and
`coding-mixed/checkout-base/100/false` ratio 1.18526 [1.03806, 1.33028].
These are selected for independent complete-group repeats. The aggregate does
not by itself resolve these individual flags.

## Corrected-source full CF control: unbound

The same complete group-paired protocol, ten alternating pairs and one warmup
pair, also completes without credential binding.

| Aggregate | Paired latency ratio | 95% interval |
| --- | ---: | --- |
| Overall | 0.97316 | 0.95441–0.99345 |
| Files | 1.04329 | 1.00302–1.11435 |
| Git/coding/recovery | 0.96517 | 0.94339–0.98140 |
| Metadata-cache variants | 1.02167 | 0.98338–1.07571 |

Overall latency decreases **2.68%**, with interval 0.66–4.56%. The file
aggregate increases **4.33%** and its interval excludes 1; this is explicitly
retained as a regression signal and investigated with selected repeats.
Of 46 >5% row screening flags, eight have pointwise intervals above 1:
file stat (100, uncached), write (100, cached), read and readdir (1,000,
uncached), append (1,000, cached), direct Git commit (1,000, cached), and
coding-small status-clean/add-rest (1,000, uncached). All six affected complete
groups are selected for ten-pair repeats; the credential-bound cohort adds its
two affected groups.

Native profile totals are 332,530 → 332,303 statements, 743,212 → 743,361 reads
(+149, **+0.020%**), and 186,846 → 186,801 writes (−45, **−0.024%**). Nineteen
row cost flags are confined to commit publication and workflows that invoke it:
some batch publication paths trade extra quota/metadata reads for fewer writes.
The full per-row counts are retained in the summary. These costs are not hidden
by the latency aggregate and are not converted into a dollar estimate.

## Independent regression repeats and adoption

Eight complete groups, each with ten alternating pairs, one warmup and a
separate cost pass, reassess all ten initial pointwise timing flags. None of
those ten flags repeats with an interval above 1. Selected-group results do
not replace or reweight either full-suite score.

| Cohort / workload / files / cache | Repeat ratio | 95% interval |
| --- | ---: | --- |
| demo / git-shell:pull-one / 100 / false | 0.99695 | 0.82464–1.25000 |
| demo / coding-mixed:checkout-base / 100 / false | 1.00249 | 0.86468–1.19053 |
| unbound / files:stat / 100 / false | 1.01250 | 0.95455–1.09762 |
| unbound / files:write / 100 / true | 1.02345 | 0.91667–1.12658 |
| unbound / files:read / 1000 / false | 1.06808 | 0.85248–1.22022 |
| unbound / files:readdir / 1000 / false | 0.97938 | 0.91628–1.22727 |
| unbound / files:append / 1000 / true | 1.05548 | 0.94595–1.21040 |
| unbound / git:commit / 1000 / true | 1.02132 | 0.96318–1.05770 |
| unbound / coding-small:status-clean / 1000 / false | 0.97383 | 0.84960–1.08343 |
| unbound / coding-small:add-rest / 1000 / false | 0.89008 | 0.78788–1.06746 |

The repeat of cached direct Git (1,000 files) produces one **new** pointwise
flag: status-change ratio 1.06004 [1.00143, 1.25000]. Its original full-suite
ratio was 1.03929 [0.84524, 1.25114]; pooling both runs descriptively gives
1.05627 [0.97383, 1.23997]. Native SQL counts match exactly in both runs.
This is retained as an unresolved small signal, not declared fixed or proven
harmless. Pointwise intervals across many rows are not family-wise guarantees.
The initial unbound file aggregate slowdown is likewise retained alongside its
non-confirming group repeats; no claim of universal or zero-regression speedup
is made.

**Adopt both changes.** Both full-suite primary aggregates improve with
intervals below 1, the realistic task has a large repeatable CF gain, all
original row flags fail independent confirmation, and compatibility, failure,
budget and package gates pass. The small unbound SQL read increase and residual
timing uncertainty are accepted explicitly rather than hidden in the geometric
mean. The changes add no FS API, schema, dependency, default change journal or
bundle-budget allowance. Public deployment verification follows below.

Private cleanup clears 36 recorded fixture rooms (including interrupted runs
and profile rooms), then deletes both evaluation Workers. The compiled graphs
remain hash-verifiable in the evidence archive; owned generated links and local
Workers state are removed. A fresh pre-deployment public run completes all 190
rows and 60,648 checks on the old build, run
`57d63a79-27de-4a5c-8274-ce1092d5dd6d`, for a nearby production comparison.
