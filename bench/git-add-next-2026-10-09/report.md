# Git add follow-up: CF phases, one serialization, read/hash reuse

Evaluation date: 2026-10-09. These experiments start from the retained
[whole-worktree add implementation](../git-add-optimization-2026-10-09/report.md).
Only deletion-only batches up to 1,024 paths are retained. No public filesystem
API is added. General one-serialization staging and body/hash reuse are rejected;
phase instrumentation is removed after diagnosis.

## Workloads and clock

Node v24.18.0, SQLite-backed VFS and the shell Git applet. Paired comparisons
use three warmup pairs and ten measured alternating pairs. Local changed-tree
trials validate all 1,000 staged blobs outside the timed region. SQL/read
counters in `compare-changed.mjs` are captured before this validation.

Actual CF measurements use the existing Worker-to-DO RPC wall clock, one
warmup and three measured samples. These times include dispatch and operation
assertions, exclude full-body validation and teardown, and do not represent
CPU time or native Git CLI performance. All bodies are SQLite inline data;
remotes are local VFS repositories, with no R2 or external Git network.

The public suite now additionally edits every tracked file and stages those
changes before removing the worktree. `add-changed` validates every staged
blob. The first expanded suite has 124 rows and 31,472 verification checks. The
additional 20-round deletion diagnostic brings the final suite to 126 rows
and 31,640 checks per completed run. Its timer includes every index reset
and empty-index assertion; the original index is restored before the normal
one-shot deletion row.
The original rows retain their workload, clock and iteration definitions.

## 1. Actual CF phase profiling

A temporary internal add callback sampled a Worker clock at calibration,
command start, inspection completion and staging completion. An RPC-only clock
first returned unusable zero inspection durations: that attempt is archived
as `cf-phase-baseline.json`, not interpreted as a speedup.

The successful experiment refreshes the clock through a fresh HTTP request to
the existing storage-free `/health` route before each returned timestamp.
The extra consecutive clock request took 8, 9 and 9 ms. This overhead remains
inside phase intervals; no subtraction is presented as exact CPU time.

| 1,000-file initial add sample | Inspection ms | Staging ms |
| --- | ---: | ---: |
| 1 | 69 | 2,441 |
| 2 | 1,172 | 1,479 |
| 3 | 78 | 2,011 |

Unchanged add inspection took 71, 88 and 103 ms; its empty staging interval
was 11, 9 and 12 ms, consistent with the clock probe itself. Staging usually
dominates initial add, while a large inspection outlier remains. The hooks and
HTTP clock probes were removed after diagnosis. See `phase-method.json` and
`cf-phase-http-baseline.json`.

## 2. One index serialization

| Local initial add experiment | Baseline ms | Candidate ms | Decision |
| --- | ---: | ---: | --- |
| Up to 1,024 small files, 1 MiB inspected bytes | 115.59 | 124.76 | Reject |
| One engine call with bounded adapter admission | 114.47 | 117.12 | Reject |

The first experiment reduces initial index serialization/writes from eight
to one and cumulative index bytes to 72,032, but expands native compression
concurrency. Local paired ratios regress. Its actual CF run repeatedly returned
500 during polling and remained at 58% progress; it was interrupted by restoring
the bounded implementation. No completed candidate result is claimed. The
saved snapshot still contains the previous successful baseline, not candidate
measurements. The precise platform exception was unavailable, so memory
exhaustion is not stated as a confirmed diagnosis.

An isolated compiled adapter admitted 128 staging files at once and released
slots at object existence probes after compression. It provided no significant
initial-add improvement. It also depends on engine operation ordering and cannot
reliably release slots for a compression failure before the object probe; it is
not a production design. Both prototypes are excluded from the library.

Deletion-only staging has no body/hash/compression work. Increasing its bounded
batch from 256 to 1,024 paths gives one serialization for 1,000 deletions:

| Local 1,000-deletion staging | Before | Candidate |
| --- | ---: | ---: |
| Median ms, ten alternating pairs | 7.90 | 6.47 |
| Paired ratio 95% CI | — | 0.779–0.920 |
| SQL statements | 95 | 41 |
| Index serializations/writes | 4 | 1 |
| Cumulative index bytes | 105,536 | 32 |

The counters are from `local-removal-counters.json`; that single diagnostic
run's wall times are not substituted for the paired timing medians. Initial
add, unchanged add and one-file add retain their body and concurrency bounds.
The ordinary CF runs were insufficient on their own: baseline medians
100/125 ms versus candidate 63/120 ms have overlapping raw samples. A
20-round diagnostic therefore compares restored identical index bytes in
every round, includes restoration/checks in both timers and has a 100-file
negative control (both batch limits use a single serialization there).
The final repeated diagnostic and acceptance decision are recorded below.

## 3. Reusing changed bodies and hashes

A command-only raw-body cache retains at most 1 MiB/1,024 entries, keeps raw
bytes for the engine's normal autocrlf conversion, discards unchanged files,
reopens through the scoped filesystem to validate permissions and mutation
tokens on hits, cancels the unused fresh stream and charges every logical read.
Retained buffers are budgeted and released on success or error. Nothing persists
between commands.

The deployed implementation's local full-changed add is 124.08 → 121.78 ms,
paired ratio 95% CI 0.973–1.004: no established improvement. Fresh permission and
mutation checks leave SQL counts at 16,280 and read openings at 2,035. CF full-
changed staging is 1,628 → 2,091 ms; initial staging 2,454 → 2,560 ms. CF unchanged
add includes 898/1,666 ms outliers, so this is not asserted as a precise causal
regression estimate.

More decisively, with a 32 KiB host buffer limit, unchanged add of 200 files
passes before caching but fails after caching with `maxBufferedBytes`. Thus the
cache cannot be retained as implemented, even if a noisy timing looked faster.
See `local-cache-buffer-regression.json`. The cache and its internal adapter
methods are removed.

The installed Git engine does not consume the inspection hash when staging.
An isolated temporary engine copy memoized inspected blob OIDs by exact bytes
within the command. The comparison uses an equally isolated unmodified ESM
engine copy for its baseline. Body reuse is enabled on both sides. Local
1,000-file changed add is 124.12 → 120.72 ms, paired ratio 95% CI 0.930–1.001:
no established hash-only improvement. This diagnostic would require engine
changes and additional retained keys; it is not deployed or shipped. Installed
`node_modules` and dependency declarations are untouched.

`experimental-prototypes.patch` and `cf-content-reuse.patch` archive rejected
code for review, not executable library code. Temporary compiled copies and
engine modules live outside the package.

## Final CF comparison and verification

The retained implementation is the one-line removal-only batch limit change
in `retained-library.patch`. Blob batching stays at 32/128 paths and inspection
body/hash concurrency stays at 32. Configuration sharing is unchanged. No
command body/hash cache or dependency patch is shipped.

| CF deletion staging workload | Control | Candidate | Candidate repeat |
| --- | ---: | ---: | ---: |
| 1,000 files, 20 rounds, ms | 1,733 | 1,446 | 1,570 |
| 100 files, 20 rounds, ms (negative control) | 118 | 109 | 116 |
| 1,000 files, one round after diagnostic, ms | 82 | 83 | 48 |

The 20-round 1,000-file medians improve about 17% and 9% in two actual CF
candidate executions. The negative control uses one serialization on both
implementations and changes little, particularly in the confirming run.
This agrees directionally with the significant local paired improvement and
the exact reduction in SQL/index work. The ordinary single-round CF timings
remain variable; no universal latency improvement or CF confidence interval
is claimed. Full raw 20-round samples are control 1,733/2,575/651 ms,
candidate 1,551/571/1,446 ms and repeat 351/1,570/1,791 ms. Large overlap and
outliers remain. The aggregate row includes identical reset/assertion work,
so its duration divided by 20 is not presented as pure add latency.

The earlier one-shot alternating comparison was 100/125 ms for the controls
and 63/120 ms for candidates. That weak repeat motivated the 20-round workload;
it is not selected as the strongest speedup figure. The general initial add
path is unchanged, and the remaining initial-add bottleneck is not solved.

Final production deployment: `e4dc525d-a03d-488a-9aed-8d6b9ce08e70`.
Implementation SHA-256: `d073e51443ed2f9393f22d00fa68d19683238b2f5d7bcf7a6141589c8279d712`.
Latest confirming run: `fd892000-c54b-4849-b1d7-cb5ae4edb0a4`.
Public page: https://vfs.borca.ai/benchmarks/.

Ten CF jobs completed, with one additional interrupted large-batch candidate.
One completion was the invalid RPC-only phase-clock experiment. The run ledger
keeps these distinctions explicit rather than counting a stale saved baseline
as a completed candidate. The final two jobs each have 126 rows and 31,640
verification checks.

`npm run check` passes: 1,884 Node tests, 143 workerd tests, the declared POSIX
comparison 46/46, typegen/build/typecheck, lint/knip/quality/docs, benchmark
protocol, execution limits, isolated package checks and all 12 tree-shaking
presets. Git is 543,328 bytes, one byte larger than this task's baseline; core
VFS, shell and default-registry bytes stay unchanged. Default-budget mixed/large
body Git tests and the 1,000-file public workflow retain their correctness gates.
The retained Git library was also smoke-tested on production deployment
`062c1fa5-56df-4bee-aabf-2a50748d78c7`: the real public shell creates/commits
64 files, stages all their removals, commits the deletion and cleans up its own
unique scratch directory. The final deployment has identical Git library code
and additionally publishes the 20-round benchmark row.

`source-fingerprint.json`, `verification.json`, `production-summary.json`,
`public-final-reuse.json`, `public-final-ui.txt` and `public-shell-smoke.txt`
record the final verification. Public requests still reuse the VFS result
file for ten minutes according to actual mtime; no live clock probes or new
public FS APIs are installed.
