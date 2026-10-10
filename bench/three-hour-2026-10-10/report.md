# Three-hour VFS optimization evaluation

Optimization window: 2026-10-10 06:06:50–09:06:50 UTC. Baseline library source
`02f2ef3f9b33deaf9d03659fe366b3a5450e6400` (unchanged since `0c544003`).
Final decision: no runtime optimization adopted; production remains unchanged.
No filesystem API or persisted schema is added.

## Candidate decisions

| Experiment | Evidence | Decision |
|---|---|---|
| Assign into the new metadata object rather than spread | Full local ten pairs neutral | Rejected |
| Slice ancestor paths without repeating normalization | Full local ten pairs neutral, one confirmed flag | Rejected |
| Synchronous materialized-byte collection | Full local ten pairs neutral | Rejected |
| ASCII name comparison before UTF-8 encoding | Full local ten pairs neutral | Rejected |
| Cache globally empty tombstones | Full local 20 pairs neutral; savings disappear after removals | Rejected |
| Skip known-empty tombstone deletion | Full local 20 pairs neutral despite fewer statements; extra invalidation complexity | Rejected |
| Reuse parent rows during batch publication | Target clone improvements, but full CF parent-only 10 pairs overall 1.0112[0.9726,1.0204] | Rejected |
| Fuse credential-bound reads with stat's permission envelope | Local improvement; combined full CF ROOT 10 pairs overall 0.9981[0.9900,1.0060], confirmed flags | Rejected |
| Remember one validated canonical path string | Local isolated/incremental improvement; narrowed full CF UID1000 ten pairs overall 0.9966[0.9860,1.0171], confirmed flags | Rejected |
| Return the private single input chunk without a second copy | Actual CF 64 KiB input: 128→64 KiB peak buffer reservation;96 KiB budget failure→success | Rejected as part of the final combination; standalone full CF latency approval not established |
| Cache parent metadata between read operations | Shared-binding revision/depth guards; local UID1000 full 10 pairs overall 0.8294[0.8252,0.8366] | Rejected: repeated material CF shell population regression |

Ratios are candidate/baseline; lower is faster. Isolated positive rows and
reduced SQL statement counts do not approve a latency claim. In particular,
local gains from removing SQL boundary calls repeatedly failed to transfer to
CF. Confirmed flags on rejected combinations were not waived to keep them.
All full observations, targeted followups and rejected patches are retained.
`inventory.md` indexes them; interrupted final-v3/v4 checkpoints are not
approval evidence. Older and newer protocols are kept separate.

## Rejected final candidate design

The parent cache stores at most 256 directory metadata projections, with no
file bodies or authorization verdicts. Every access still evaluates the
caller's UID/GID/groups against parent permissions, and file permissions
against freshly read file metadata. A WeakMap keyed by the SQL binding shares
a generation and transaction depth between filesystem instances. Every VFS
transaction invalidates cached metadata on entry and completion, including
nested calls and rollback. The cache is disabled throughout any transaction
on that binding. A partial cache miss uses the original complete ancestor
query, preserving missing-ancestor and denied-traversal error precedence.

The single-chunk collector returns its existing private clone and retains the
same lease. Its final deadline/abort check is preserved. Timeout releases the
lease, and later mutation of the original input cannot change the returned
bytes. The CF probe measures **shell-owned buffer reservation**, not process RSS.

The measured candidate had no batch-publication parent cache, known-absence
cache, fused-read query or global canonical-path cache.

## Measurement protocol

The full plan has 190 distinct workloads: 146 uncached (18 file operations,
128 Git/coding/recovery) and 44 optional adapter metadata-cache variants.
Each workload has equal weight in its family's geometric mean. Cache variants
are not mixed into the uncached overall index. Full body/checkout validations
run outside timing; operation assertions remain inside. Version validation
counts and workload identities must match. SQL profiling is a separate pass.
Node returned rows are not billed CF reads; Node also observes explicit
transaction-control statements that native DO transactions do not execute
through the metered SQL wrapper.

Complete baseline and candidate graphs are separately compiled with matching
dependencies. An initial local A/A control exposed first/second-order bias.
Later local runs alternate order with both stage and pair index
(`STAGE_ORDER=1`) and have a fresh A/A control. Supplementary balanced analysis
of earlier runs is saved, but not pooled with the later protocol. Paired
bootstrap confidence intervals describe sampled trials, not universal limits.

The private CF harness alternates complete version order in the **same Durable
Object**, deleting evaluation storage and creating a fresh FS between versions.
Front-Worker RPC timing includes dispatch, execution and persistence; client
internet latency, setup and full-body validation are excluded. Warmups and a
separate metered profile pair are excluded from timing. Actual cursor rows
read/written and statement counts are recorded separately. The compatibility
date is 2026-07-24. This is a sequential steady-state evaluation, not a cold-start
or concurrent-load study. Its authenticated endpoint uses dedicated storage.

Early Git timestamps changed commit hashes and the number of object-prefix
directories, producing cost noise. The fixed-fixture protocol injects Git
identity time 1700000000000 in BOTH graphs; shell deadline clocks remain real.
Public default benchmark behavior keeps its existing clock. Do not pool the
old and fixed-fixture observations. UID1000 comparisons initialize their
isolated root as 0777 so the fixed `/scratch` plan can execute as that principal;
this setting belongs to private evaluation storage. Credentials and root mode
are recorded. The default public plan has no POSIX credentials; it does not
exercise the new credential-bound hot path, so its aggregate is a control.

## Compatibility and resource guards

The rejected candidate passed 1967 Node tests and 156 Workers tests, 46 native/POSIX
comparisons, 31 workerd performance guards, typecheck, quality, lint, knip and
12 tree-shaking/bundle budgets. Final baseline verification after restoration is recorded below.

New behavior tests cover principal/group separation, file permissions after
parent-cache hits, chmod/chown, directory replacement, symlinks, error
precedence, shared-binding instances and rollback. In the rejected candidate, the directory-listing
budget was tightened to the trusted statement count. Existing workerd warm
stat guards at depths 1/16/64 now read 500/500/500 rows for 500 stats, previously
3500/26000/98000. Statement counts stay 500. Rename controls stay unchanged.
Single-chunk tests cover bounded reservation, private ownership and late-EOF
deadline cleanup. Existing quota/guard and stream-race tests remain enabled.

## Reproduction and evidence

Create an owned baseline worktree at 02f2ef3. Run `prepare-fixtures.mjs WORKTREE`
for matching optional-clock benchmark fixtures; the library remains baseline.
Use `compile.mjs SOURCE_ROOT OUTPUT_ROOT` to compile each complete graph into
separate directories. Candidate patches apply to the baseline library source.
Generated graphs and private secret files are ignored by Git. Archived gzip
files preserve original bytes; decompress before passing to plain-JSON tools
or `git apply`. `inventory.json` records decompressed SHA-256 hashes.

```sh
node bench/three-hour-2026-10-10/prepare-fixtures.mjs BASELINE_WORKTREE
node bench/three-hour-2026-10-10/compile.mjs BASELINE_WORKTREE bench/three-hour-2026-10-10/compiled/baseline-fixed
node bench/three-hour-2026-10-10/compile.mjs CANDIDATE_ROOT bench/three-hour-2026-10-10/compiled/candidate
CREDENTIALS=demo FIXED_GIT_TIME=1 STAGE_ORDER=1 PAIRS=10 node bench/three-hour-2026-10-10/local-pairs.mjs bench/three-hour-2026-10-10/compiled/baseline-fixed bench/three-hour-2026-10-10/compiled/candidate local.json
npx tsc -p bench/three-hour-2026-10-10/tsconfig.json
npx wrangler deploy --config bench/three-hour-2026-10-10/wrangler.jsonc
COLOCATED=1 CREDENTIALS=demo PAIRS=5 WARMUPS=1 CANDIDATE=DEPLOYED_LABEL node bench/three-hour-2026-10-10/remote-pairs.mjs cf.json
```

Configure the private EVALUATION_TOKEN secret separately. The runner verifies
the source label on every response, checks 190 full-plan keys and corresponding
validations, checkpoints per group and clears timing/profile rooms in a finally
block. BENCH_GROUPS selects complete stateful groups for followups, not isolated
operations without their prerequisites. Credentials must match for comparisons.
The CF memory probe is `memory.mjs OUTPUT.json` with the same CANDIDATE variable.

## Final CF results and deployment

The full credential-bound CF comparison used UID/GID 1000, five alternating
pairs, one warmup and all 190 workloads. Candidate build label:
`traversal-cache-v2-1d3d16785aef`; runtime-source SHA-256:
`1d3d16785aef0b125acacf21c7082a2704982b537a2b2f0354c66fbbf43fec6e`.

| Family | Workloads | Candidate / baseline [95% CI] |
|---|---:|---:|
| Uncached overall | 146 | 0.8896 [0.8756, 0.9265] |
| Uncached file operations | 18 | 0.9060 [0.9004, 0.9986] |
| Uncached Git/coding/recovery | 128 | 0.8881 [0.8718, 0.9167] |
| Adapter metadata-cache variants | 44 | 0.9708 [0.9400, 1.0068] |

The separate native-CF SQL profiling pass totals all 190 workloads:

| Counter | Baseline | Candidate | Change |
|---|---:|---:|---:|
| SQL statements | 663,686 | 553,153 | −16.65% |
| Actual rows read | 10,482,157 | 8,185,228 | −21.91% |
| Actual rows written | 227,815 | 227,815 | unchanged |

No individual workload increased these SQL counters. This does not establish
an equivalent dollar savings or remove per-workload latency requirements.
The full run flagged nine slowdowns, two with confidence intervals above one.
Every flagged workload's complete group was rerun in ten alternating pairs.
The followup improved its uncached aggregate but flagged six slowdowns, three
with intervals above one: cached 100-file init (1.0845), cached 100-file commit
(1.0519), and 1000-file shell population (1.1223). These are material adoption
concerns despite the faster overall result. A second independent ten-pair
confirmation of all three complete groups reproduced the shell population
regression: 1.1859 [1.0737, 1.2599], versus 1.1223 [1.0349, 1.2149] in the first
followup. Each block independently confirms a material slowdown. Combining all
20 matched pairs (without discarding trials) gives 1.1390 [1.0797, 1.2014].
The matched cached-init pairs also give 1.0822 [1.0139, 1.1166], although its
second block alone is inconclusive. `confirmation-analysis.json` preserves
both block summaries and all matched pairs; it is not a full-suite result.

**Decision: reject the complete cache/collector candidate.** Library source and
performance guards were restored to baseline. The isolated collector has a
real CF reservation benefit, but no separately approved full CF latency
comparison; it was not shipped by borrowing approval from a rejected combination.
No filesystem API or schema changed. Additional behavior-only POSIX tests and
deterministic private benchmark fixtures are retained.

The original three-hour optimization window ended at 09:06:50 UTC. Subsequent
work only confirmed flags and finalized restoration, checks and evidence;
no new optimization was started. The last confirmation completed at 2026-10-10T09:25:26.377Z after the
window. No production deployment was performed, so no post-deployment speedup
or build verification is claimed. The public deployment still identifies
commit `6c6cfbfa90c2657e34e1cb9223e75455ff767be4`, build
`dfd557209fd2cb3a898779fa2c9c4958cb540fb3f3c4f783b54cfe759bbb1a30`.
The fresh public baseline run is `bfc8caa4-0716-4840-a87b-00081096a8f8`, with
190 workloads and 60,648 body validations.

The private Worker imports candidate source from the main checkout. To
reproduce a rejected experiment, apply its archived patch there before
compiling/deploying; compiling a separate candidate graph alone does not
change the Worker imports. Never deploy these rejected candidates to production.



## Final restored-source checks

Library source under `src/`, warm-stat cost budgets and listing SQL guards are
identical to the baseline. The retained changes are private comparison tools,
optional deterministic Git fixture clocks (default public behavior unchanged),
documentation and additional behavior-only tests.

After restoration: 1,964 Node tests, 156 Workers tests, all 46 native/POSIX
comparisons, all 31 workerd performance guards, typecheck, lint, knip,
documentation checks and all 12 bundle budgets passed. Existing lint warnings
and informational diagnostics remain. Candidate and restored check logs are
saved separately as lossless `.log.gz` archives. The temporary `cf-vfs-full-evaluation` Worker was deleted
successfully; dedicated test rooms were cleared by the runners.
