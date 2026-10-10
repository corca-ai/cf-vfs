# Git staging API experiments, 2026-10-09

Three proposals were evaluated: bounded engine staging with one index
serialization, existing `writeFiles` for loose objects, and batched metadata
queries. Only bounded loose-object writes are retained. The original optional
Git peer dependency and its installed files are unchanged. No metadata batch
API or Git engine fork is shipped.

## Measurement

Node v24.18.0, SQLite VFS, shell Git command and isomorphic-git 1.43.1.
`compare-add.mjs` runs three warmup and ten measured alternating pairs and
validates all 1,000 staged blob contents outside the timer. Each trial uses a
fresh filesystem. SQL/read counts are captured before validation.

CF uses the existing 126-row public suite: one warmup, three measured samples,
31,640 verification checks per completed run. Worker-to-DO RPC wall time includes
dispatch and operation assertions; full-body validation and teardown are outside
the timer. These are inline SQLite workloads, not native Git CLI, R2, external
network remotes or CPU-time measurements. Request colos differ, and raw samples
have substantial overlap and outliers; observed median changes are not a
universal causal speedup estimate.

## Bounded one-serialization engine API: rejected

An isolated engine copy processes selected paths in consecutive 128-file
batches inside one `GitIndexManager.acquire` closure, preserving bounded
compression while serializing the index only at the end. The equally isolated
baseline uses the original ESM engine and ordinary shell batches. No installed
engine file is edited. See `prepare.mjs` and the isolated engine patch.

Initial add is 117.35 → 114.25 ms, paired ratio CI95 0.934–0.997. A repeat is
116.40 → 113.52 ms, CI95 0.950–1.003. Fully changed staging is
128.45 → 123.89 ms, CI95 0.914–1.059. The gain is small and not consistently
established. Shipping it would also require an engine fork or an upstream API;
the adapter cannot request this behavior through the installed public engine
interface. It is not deployed or retained.

## Loose objects through existing writeFiles: retained

An isolated engine experiment first demonstrates the write-phase opportunity:
bounded one-index staging with individual object writes versus the same engine
with object sets committed using `writeFiles`. Its initial-add paired ratio is
0.846, CI95 0.820–0.899, and SQL drops 19,040 → 10,843. This engine prototype
is not shipped: its first implementation lacks the final mode and budget guards.

The retained implementation works with the original Git engine. During each
normal staging batch it retains only compressed loose-object writes, ensures
parent directories, and commits those objects before acknowledging the index
write. It shares directory creation within the command and still validates
permissions, traversal, modes, quotas and mutation budgets at actual writes.
Any flush failure stays fatal to subsequent index retries; the command-local
state and reservations are discarded on exit. Individual filesystem API writes
are unchanged.

The adapter retains the existing 32/128-file body batches, 1 MiB small-body
inspection bound, compression behavior and index serialization. Batches below
32 bodies use individual writes. Memory is charged to the shell, and capacity
is bounded by backend headroom with room left for working-file reads. Unknown
capacity or insufficient headroom disables batching.

Local adapter-prototype initial add is 109.60 → 98.30 ms,
paired ratio CI95 0.836–0.919; SQL 19,180 → 12,726. Fully changed staging is
115.22 → 115.81 ms, ratio CI95 0.948–1.020, so no local changed-add speedup is
claimed.

The initial CF object candidate records 1,000-file initial add
2,840 → 1,773 ms, and fully changed add 2,389 → 1,915 ms. Its single-file
path was subsequently restored to ordinary writes. Final measurements and
verification below will refer to the tuned production implementation.

## Multi-path metadata API: rejected

A bounded `statMany` SQL prototype coalesces overlapping Git lstat requests,
preserves ordering and duplicates, and falls back to ordinary stat/lstat for
credentials, symbolic links, dot components, trailing slashes and opaque data.
Errors fall back to individual requests rather than making unrelated missing
paths fail together. Snapshots are never cached across commands.

Trusted direct metadata lookup of 1,000 files improves 4.536 → 3.184 ms,
CI95 ratio 0.684–0.733; SQL 1,000 → 1. Credential-bound lookup retains
1,000 statements and has no established gain, CI95 0.977–1.011.

The initial shell prototype reduces initial-add SQL 19,180 → 17,201, but its
paired ratio CI95 0.961–1.011 does not establish a speedup. On top of the object
candidate, unchanged add is 34.80 → 33.98 ms, CI95 0.962–0.995, with SQL
2,024 → 1,032. That small local benefit does not carry to the actual CF run:
1,000-file unchanged add is 60 → 76 ms, initial add 1,773 → 2,167 ms, changed
add 1,915 → 2,244 ms. Raw samples overlap, so no precise causal regression is
claimed, but there is no demonstrated CF benefit sufficient to retain a new
API. `rejected-metadata.patch` archives the tested implementation and tests.
The experimental wrapper also exceeded the source file length gate; it is
removed, rather than relaxing that gate.

## Minimal retained capacity information

`availableWriteBufferBytes?: number` is an optional advisory property, forwarded
by SQL, credential, collaborative and shell views. It lets consumers of existing
`writeFiles` plan bounded sets, but is not a reservation and does not change
atomicity, quotas or concurrent `EAGAIN` behavior. Backends without it use the
original path. The shell budget also offers an optional headroom query.

A focused regression test exposed a real problem in the first object candidate:
100 tiny incompressible files fit individual reads and the index within an
8 KiB VFS in-flight budget, but retaining the whole compressed object set failed.
Bounding each flush by reported headroom fixes this case. Shell 32 KiB buffer
limits, umasks 077/002, index publication after object durability, retriable-looking
ENOENT flush failure, recovery, existing-object mode preservation, scoped roots, reserved devices,
mutation limits and small single-file staging are tested.

## Final verification

The final implementation restores the ordinary read/stat path without an extra
await whenever object batching is inactive. This addresses unnecessary
scheduling overhead observed while checking the small-add controls. All final
measurements below use the same deployed source, including backend headroom,
mode preservation and small-set fallback.

| Final local workload, 1,000-file repo | Baseline ms | Final ms | Paired ratio CI95 |
| --- | ---: | ---: | --- |
| Initial add | 115.332 | 99.770 | 0.840–0.879 |
| All tracked files changed | 124.610 | 120.608 | 0.933–0.973 |
| Unchanged add | 34.101 | 34.058 | 0.982–1.012 |
| One selected file changed | 7.501 | 7.189 | 0.886–1.082 |

Initial-add SQL drops 19,180 → 12,726; changed-add SQL drops
16,280 → 11,772. Read openings are unchanged. One-file add retains 58 SQL
statements and 16 read openings. Unchanged add retains 2,024 statements and
1,011 reads. No speedup is asserted for the last two local rows.

Instrumented `local-final-counters.json` is a structural diagnostic, not a
latency benchmark: index serialization/writes remain eight and cumulative
index bytes remain 330,304. Individual object write attempts fall from 1,249
(including 249 failed writes before directory creation) to 1,000 entries in
eight atomic sets of 128/128/128/128/128/128/128/104. Both versions validate
all 1,000 staged blobs.

| Final CF shell workload | Baseline ms | Final run ms | Repeat ms |
| --- | ---: | ---: | ---: |
| Initial add, 100 files | 104 | 76 | 68 |
| Initial add, 1,000 files | 2,840 | 2,059 | 2,196 |
| All tracked changes, 100 files | 132 | 106 | 78 |
| All tracked changes, 1,000 files | 2,389 | 2,062 | 1,424 |
| Unchanged add, 1,000 files | 84 | 73 | 83 |
| One-file add, 1,000-file repo | 64 | 64 | 73 |

These are per-run medians of three samples. All three requests above report
LAX; raw samples still overlap and include outliers. The initial 1,000-file
add median is about 23–28% lower in the two final runs. No formal CF confidence
interval or universal speedup is claimed. Earlier object and metadata
experiments and the intermediate tuned object implementation remain archived
under distinct filenames; their measurements are not pooled into this table.

Production deployment: `284d7b6d-e3d7-4f9b-a264-24efca927636`.
Implementation: `06129cc631c2c5e6a83ce001121c8d9729e8d0965bfd94a4b14617be4f8a5ac1`.
Final saved run: `2566cafc-e145-44dd-8520-6c19c029b995`.
Both final runs have 126 rows and 31,640 verification checks. Seven CF jobs
completed across four deployments during this task. The independent source
fingerprint verifies all 202 deployed source/config/asset files, Worker headers
and the stored DO result. Public unauthenticated POST reuses the same run and
exact VFS mtime within the unchanged 600,000 ms TTL.

`npm run check` passes: 1,898 Node tests, 143 workerd tests, 46/46 declared
POSIX comparisons, typecheck, lint, knip, quality/docs, benchmark protocol,
execution limits, isolated package checks and all 12 bundle presets. Core VFS
is 207,972 bytes (+251); optional Git is 547,437 (+4,109); shell/default
registry grow by 857 bytes. All original budgets pass without increasing them.
The public credential-bound collaborative shell stages and commits 32 distinct
files, commits one subsequent edit, reports clean status after both commits,
and removes only the uniquely named smoke repository.

## Reproduction and artifacts

`retained.patch` contains only this task's delta from the pre-existing dirty
workspace. Reconstruct the baseline by reversing it in an isolated copy of the
final tree, keeping all earlier workspace changes, and build that copy. Do not
reverse it in the active workspace. Pass baseline/final dist directories to
`compare-add.mjs`; `ADD_MODE=initial|one|unchanged` selects the workload and
omitting it selects all changed files. `PROFILE_ADD=1` collects structural
counters only. `prepare.mjs BASELINE_DIST` and
`prepare-metadata.mjs BASELINE_DIST` prepare isolated compiled prototypes under
`/tmp`; the engine/object and metadata patches archive the rejected source.
`compare-metadata.mjs OUT CANDIDATE_DIST` requires the rejected metadata build.
The source-editing metadata draft is archived as `.rejected.txt`, not run as
part of production. `verify-production.mjs` checks deployed hashes and public
cache reuse without credentials. The normal benchmark developer CLI keeps its
authorization token inside its existing local environment loader.

