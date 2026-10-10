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
Full matched CF suite evaluation is in progress. No budget has been changed.

