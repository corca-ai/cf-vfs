# Five-hour POSIX optimization run, 2026-10-10

Window: 10:39:23–15:39:23 UTC. Initial source `a03a31d`; initial public
implementation `08b8e0b`. Results below are adoption checkpoints; the experiment
ledger and lossless raw data are in [five-hour-2026-10-10](five-hour-2026-10-10/README.md).

## First adoption: `d285026`

Canonical ancestor enumeration and ASCII normalization avoid repeated parsing.
A bounded directory metadata cache reuses rows already fetched by stat/list,
while retaining per-principal access checks and transaction invalidation.
Recursive credential-bound copy now drives its indexed child lookup from each
parent, eliminating quadratic scans. Single-entry rename publishes tombstones
and updates paths through indexed equality queries. No public API was added.
The preceding `13b1106` also propagates asynchronous Git removal errors.

Full-plan ten alternating actual-CF pairs, with a warmup and timing separate
from native SQL profiling, compared immutable complete runtime graphs:

| Credential mode | Overall latency ratio (95% bootstrap CI) | Files | Git/coding/recovery |
| --- | --- | --- | --- |
| UID/GID 1000, demo | 0.9577 [0.9496, 0.9723] | 0.8889 | 0.9686 |
| Unbound control | 0.9877 [0.9749, 1.0226] | 0.9287 | 0.9953 |

Lower latency ratios are better. The primary reciprocal geometric-mean score
improves 4.42%; the unbound control does not establish a timing improvement.
The primary aggregate contains all 146 uncached workloads, with equal workload
weight. Optional metadata-cache workloads are reported separately (primary
ratio 0.9316; unbound 0.9705), rather than mixed into the primary outcome.

Native SQL totals cover all 190 profiled stages, including cache variants:

| Mode | Statements before → after | Reads before → after | Writes |
| --- | --- | --- | --- |
| Demo | 553153 → 551818 | 8185228 → 1993959 | 227815, unchanged |
| Unbound | 370226 → 370257 | 5042149 → 993442 | 216461, unchanged |

These are read-count reductions (75.6% and 80.3%), not dollar savings estimates.
Eight small demo checkout cost flags remain; aggregate cost is lower. The
unbound 31-statement increase and individual timing flags are retained in the
raw evidence. A ten-pair targeted repeat has no SQL cost flags: that increase
did not reproduce. Of seven initial confirmed unbound timing signals, cached
append (1000 files) reproduces, ratio 1.2321 [1.0611,1.4921]. The repeat also
flags checkout-base (1000 files), 1.0849 [1.0076,1.2713], which was not one of
the initial seven. Its selected uncached aggregate is inconclusive, 0.9976
[0.9891,1.0130]; this selected result is not a full-suite aggregate. Two confirmed demo
coding-mixed-100 timing signals did not reproduce in another ten-pair targeted
comparison (zero confirmed flags). Per-workload flags are not family-wise causal
proof: the identical-code CF control also produced seven pointwise flags.
Adoption follows the user's explicit aggregate-score tradeoff policy.

Revalidated release gates: 1974 Node tests, 156 Workers tests, 46/46 native POSIX
comparisons, 35 native SQL guards, all 12 unchanged bundle presets; typecheck,
lint, quality, unused-code, documentation, execution-limit, comparison-protocol
and package checks pass. Quality reports one expected unused-suppression warning
for the intentional NUL regex annotation. The release graph differs from the
measured graph only in that comment; every emitted JS module was compared after
comment-stripping normalization, recorded in `round2-release-equivalence.json`.

Public deployment: source `d285026`, implementation
`22df29143160fc8daf55ecfe0c2cce7e298b2976b4943ac2fdf3b59eb802aa28`,
Worker version `fa8e9a32-6283-4c20-b4ba-ee44a78ba6f3`.
Public shell verification passed local clone, pull, clean status and warm-cache
chmod denial/restoration, with cleanup. Both public full-plan runs completed
190 rows and 60648 checks for the expected build, but their descriptive overall
ratios versus the morning public baseline are **1.132 and 1.196** (slower).
Both use LAX and the same engine/protocol. This conflicts with the matched
credential-bound CF improvement and is not explained yet; it must not be
presented as a public-page latency improvement. The unbound matched control
was inconclusive. Further matched CF testing and public verification continue.
Raw public runs are retained; same-commit history replaces the earlier point.

## Next candidate, not yet adopted

Round five compares against the accepted round-two graph in the same private
DO, alternating versions. It combines a nineteen-field JSON entry envelope,
indexed descriptor and statById identity lookups, point change-feed publication
and point file-copy queries. Existing field validation, identities, hardlinks
and detached descriptors remain covered. Native CF probes already confirm
1000-file identity/fstat-100 reads 100200 -> 200, alias variants 100200 -> 300,
byte-write-100 reads 100600 -> 600 and truncate reads 2038 -> 38, with unchanged
statement/write counts. These probes do not establish timing improvement: DO
clock-zero samples are retained and excluded, with no epsilon. Initial summary
failed on zero clocks; recovery summarized the same verified raw cost samples.
The primary full matched CF comparison completed: latency ratio 0.979470
[0.953136,0.989250], fourteen pointwise signals but zero confirmed timing or
native cost flags. All190 SQL totals are identical to round two. Its unbound
control was cancelled during warmup with zero measured rows; both rooms were
explicitly cleared to test the final combined candidate instead. This
intermediate has not been adopted.

## Second adoption: `6520dbe`

Credential-bound append commits retain bounded directory access metadata only
while all active transactions change file contents. Ordinary nested mutations
still invalidate and disable reuse, every access checks its principal, and
rollback discards metadata. Unbound append retains ordinary invalidation.
New behavior tests cover principal changes, chmod while an append body yields,
and warmed metadata after a nested chmod that rolls back. All1977 Node tests,
156 Workers tests, POSIX46 and native SQL45 pass, along with other checks.

Final-form local ten-pair comparisons against accepted round two:
demo overall0.947443 [0.944896,0.949693], files0.874402, Git0.957205;
unbound overall0.968416 [0.954622,0.975021], files0.949850, Git0.970629.
The unbound optional cache aggregate1.012581 [0.997844,1.043042] is
inconclusive. Local uncached read1000 slowdown reproduces in an independent
ten-pair repeat, ratio1.052837 [1.014522,1.206290], medians9.208 ->9.685ms.
The initially flagged cached commit-one100 2.14x slowdown does not reproduce;
a new cached checkout-old100 pointwise flag appears. Raw data retain these
tradeoffs. Local returned-row variations are not Cloudflare billed costs.

Native actual-CF append1000 uses7999 ->6000 statements,18994 ->7000 reads,
3000 writes unchanged, confirmed in three alternating pairs at each size.
Content, identity, token and chmod-denial checks pass, with final cleanup.
The final demo full ten-pair CF comparison completed against accepted round
two: overall0.978942 [0.951442,0.986236], Git0.973694, files0.976757
[0.947682,1.014028], optionalcache0.983460 [0.957456,0.998991]. The primary
reciprocal score increases2.15%. Four pointwise confirmed latency flags remain
(checkout-old100, shellchange-all1000, mixedcheckout-base100 and mixeddiff1000).
Recoverycheckout-failure100 uses62 extra statements and93 extra native reads,
with unchanged writes. Full totals still fall551818 ->547484 statements and
1993959 ->1954488 reads, writes227815 unchanged. The unbound full ten-pair
control completed: overall0.989547 [0.974384,1.013681], Git0.994250,
files0.989325, optionalcache0.998991 [0.996360,1.006205]. This does not establish
a timing change. Two pointwise flags remain (status-clean100 and shellclone100),
with zero cost flags. Native counts370226 statements/993349 reads/216461 writes
are identical in both versions. Independent signal repetitions completed
in both modes; their results are recorded below. Source adoption follows the user's full-suite aggregate policy:
the primary confidence interval establishes an improvement, the unbound full
control is inconclusive, compatibility gates pass and total native cost falls.
Individual latency tradeoffs and the small recovery cost variation remain
disclosed; their repetition is additional investigation, not hidden evidence.
Frozen graph hashes and deployment fingerprint are in cf-round11-deployment.json.

Bundle budgets were explicitly regenerated for all twelve presets using the
existing measured-size-plus-five-percent rule, rounded up to128 bytes. Raw VFS
is214323 bytes, +820 bytes (+0.38%) versus round two; R2 also grows820 bytes,
and opt-in FS adapters grow1060 bytes. This tiny implementation growth had
exceeded two original caps; the other presets fit. All presets, not just those
two, were re-recorded deterministically. The larger cap differences restore
five-percent headroom after earlier accumulated growth; they are not code-size
growth. Import exclusions, forbidden dependencies and lower tolerance0.75 are
unchanged. Exact before/after raw sizes and caps are retained in
round11-bundle-budget-record.json.


## Additional native cost checks

These counts come from actual Cloudflare SQLite probes, independent of wall
clock timing. Inputs and outputs are verified; statements and writes stay
unchanged for the identity/copy rows.

| Probe | Before reads | Final candidate reads |
| --- | ---: | ---: |
| 100 descriptor stats in a 1000-file namespace | 100200 | 200 |
| 100 inode lookups in a 1000-file namespace | 100200 | 200 |
| 100 descriptor stats through an alias, same namespace | 100200 | 300 |
| 100 one-byte descriptor writes, same namespace | 100600 | 600 |
| Truncate a 1 MiB file, same namespace | 2038 | 38 |
| Point copy, 1000-file namespace, change feed off | 2039 | 33 |
| Point copy, 1000-file namespace, change feed on | 3044 | 34 |
| Rename publication, 1000-file namespace, change feed on | 1026 | 23 |
| Append 1000 credential-bound files | 18994 | 7000 |

Append additionally reduces statements7999 ->6000, with3000 writes unchanged.
The identity probes have zero-valued DO-local clocks, so their timing ratios
are null. No artificial clock epsilon or latency claim is used.

A separate native local test with100/1000 contiguous aliases and the original
path removed preserves inode/link count in both versions. That layout already
allows the old query to stop early: its two reads become three, constant in
alias count. This one-read tradeoff is disclosed rather than presented as a
universal identity-query improvement. Source and both logs are retained.

## Final source deployment

Source6520dbe is pushed and publicly deployed as build
678a943d59904199061bdc6f7f44c7607d22446b7ed62466c7805cd27a493a79,
Worker version a4f7711f-61b6-4afa-b5d8-da836d2d8a8e. Every117 emitted JS
module in the release graph is byte-identical to the final measured graph;
no comment normalization is needed. Exact SHA256 is
47e3e8c47d4b28b9565de712c41bfd6f0cee947bc39f4017dc3de93d1f4c1405.
The public shell clone/pull/content, clean-status and warm-cache chmod denial/
restoration verification passes, with cleanup. Post-deploy full public timing
verification is complete; see the final public result below.

All ten owned experimental worktrees have been removed after losslessly
archiving their tracked binary diffs, base commits and every untracked source
file in owned-worktree-snapshots.json.gz. Both release worktrees were subsequently removed after final verification. The38 complete measured/release JS graphs are archived;
redundant dependency copies were removed without changing either graph SHA.

## Independent final signal checks

Ten alternating pairs per mode repeat all six initially confirmed signals.
None reproduces: demo selected68-workload aggregate0.991233
[0.957648,1.027190], unbound selected32-workload aggregate0.968299
[0.929994,1.016800]. These are selected subsets, not full-suite improvement
claims. Both repetitions have zero confirmed timing and zero SQL cost flags.
The initial recovery cost increase does not reproduce. Initial signals and
repeat confidence intervals remain in cf-round11-flags-assessment.json; lack
of reproduction is not proof that no effect exists.

The final composed source also repeats the native handle/identity probes in
ten pairs and namespace/copy probes in three pairs. All24 operation/version/
size groups have ten identical cost samples, all48 namespace samples verify
behavior, and the earlier component read counts are reproduced. These final
source probes remain cost evidence only: DO-local clock-zero times are excluded
from timing claims. Owned34 evaluation rooms return successful explicit clears,
and the temporary cf-vfs-five-hour-evaluation Worker is deleted.

## Final public result and remaining limitation

The post-deploy public run completes190 rows and60648 checks in LAX for source
6520dbe, build678a943d59904199061bdc6f7f44c7607d22446b7ed62466c7805cd27a493a79,
versiona4f7711f-61b6-4afa-b5d8-da836d2d8a8e. Full raw result and all comparisons
are retained. Public developer/screening exits2 because individual descriptive
flags require review; this is not a functional failure.

| Public baseline | Current overall latency ratio |
| --- | ---: |
| morning | 1.187910 |
| round2-first | 1.049769 |
| round2-repeat | 0.992875 |

The current public default is18.8% slower than the morning sample and lies
within the two prior round-two public outcomes. It does not establish a public
page acceleration. The cause of the discrepancy with matched credential-bound
results remains unresolved. The unbound matched full10 control is inconclusive;
private harness timing excludes public job/assertion bookkeeping, so its result
must not be substituted for public latency. No causal explanation is claimed.
Three public samples are descriptive screening, not statistical proof.

An ordinary public POST immediately reuses the result, preserves its VFS file
mtime and reports exactly600000ms TTL. History contains ten points and exactly
one for source6520dbe. All twelve owned worktrees are removed, with source/data
archives preserved and the original local exclude file restored. The temporary
private Worker and all34 identified evaluation rooms are cleaned up. No new FS
API, schema migration or npm release was introduced.
