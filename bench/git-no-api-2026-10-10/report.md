# API-free Git optimization experiments — 2026-10-10

Adopted a filesystem-owned, token-validated worktree hash cache after local and
actual Cloudflare comparisons. No public filesystem methods, options, shell
commands or persisted cache formats were added. Automatic packing and the
copy-on-write prototype were not adopted.

## Adopted cache

| Operation | Local median before → after | CF RPC median before → after | CF median paired ratio [95% interval] |
|---|---:|---:|---:|
| status-first | 33.89 → 35.63 ms | 570.0 → 587.5 ms | 0.976 [0.773, 1.508] |
| status-repeat | 33.18 → 21.41 ms | 488.5 → 434.5 ms | 0.805 [0.484, 1.137] |
| add-clean | 33.16 → 21.46 ms | 584.0 → 360.0 ms | 0.599 [0.476, 0.866] |
| status-one | 33.14 → 21.28 ms | 465.0 → 372.5 ms | 0.639 [0.385, 1.046] |
| add-one | 33.28 → 22.20 ms | 590.5 → 479.0 ms | 0.818 [0.438, 0.948] |
| add-all | 116.29 → 120.40 ms | 2752.0 → 2664.5 ms | 0.995 [0.640, 1.339] |
| checkout-all | 135.51 → 123.72 ms | 2653.0 → 2204.0 ms | 0.863 [0.471, 1.502] |

The strongest CF timing evidence is clean add and one-file add: their paired
intervals exclude no improvement. Several other CF timing intervals include no
change, so their marginal medians alone do not establish a speedup. Cloudflare
latency varied substantially between pairs. Cold status and add-all have small
local overheads (roughly 2–4%); they are not claimed faster. This is an optimization
for repeated coding operations, not a promise that every command becomes faster.

Separate CF profiling gives deterministic work reductions:

| Operation | Rows read before → after | Rows written before → after |
|---|---:|---:|
| cold status | 5,134 → 5,150 | 0 → 0 |
| repeat status | 5,134 → 3,054 | 0 → 0 |
| clean add | 5,041 → 3,054 | 0 → 0 |
| status after one edit | 5,134 → 3,059 | 0 → 0 |
| one-file add | 5,079 → 3,092 | 8 → 8 |
| add-all | 20,758 → 20,774 | 4,837 → 4,837 |
| checkout-all | 24,336 → 22,256 | 2,004 → 2,004 |

Repeated status reads about 41% fewer SQL rows. These are backend work counters;
no monetary savings percentage or CPU-time reduction is inferred from RPC wall
time. Query counts and row counts are distinct: a cheap metadata query can
replace a body query without eliminating a SQL statement.

The cache retains at most 4,096 paths per live filesystem owner. Shell views use
a private weak ownership key, never a capability to reach the unscoped filesystem.
Caches cannot cross filesystem boundaries even when opaque tokens collide.
Within each command, the Git adapter retains bounded metadata from existing
stat/body reads. A matching token/inode/CRLF setting is only a candidate hit;
a scoped EOF read authorizes access and checks the current overlay snapshot before
reuse. Hashes are seeded from metadata paired with the actual full body read.
Tokens are compared, never parsed. Symlinks and changed/unadmitted paths retain
normal reads. Stable admission avoids thrashing when a tree exceeds capacity.
Logical I/O and conservative shell buffer checks still apply on cache hits.

No content bodies or SQL hash cache records survive the command through this
optimization. The weak cache does retain small hash/token records while its
filesystem owner lives; a reset loses them safely. Hosts must serialize repository
operations and document changes as before. The shared shell ownership helper adds
396 bytes to the plain-shell bundle; all 12 existing bundle budgets pass and Git
remains absent from non-Git presets.

## Rejected first cache implementation

The first implementation mapped SHA-256 from existing digestFile to Git blob
identities. Local repeated operations improved about 25–28%, but CF cold status
rose from a 403 ms marginal median to 708 ms, with 1,000 additional SQL writes
and rows read rising from 5,134 to 11,150. It was rejected and replaced rather than
shifting that initialization cost into another command. See digest-cache-local,
digest-cache-expanded and digest-cache-cf JSON, plus the preserved rejected helper.

## Pack experiment

Local two-generation repositories have about 2,000 loose blobs plus trees/commits.
Using existing Git SDK packObjects/indexPack and removing loose objects only after
index validation reduced clone from 111.97 to 73.71 ms and checkout-all from
141.97 to 119.36 ms. Preparation took 374.72 ms: roughly ten subsequent clones are
needed to repay that preparation in this workload. SQLite allocated size increased
from about 3.60 MB to 5.05 MB while preparing and removing loose files. Freed pages
are not the same as an immediately smaller allocated database, so reduced storage
billing is not claimed.

The first CF pack run showed a clone improvement, but candidate checkout also
contained the rejected digest cache and is not an isolated packing comparison.
Its validation harness repeatedly decoded the pack with fresh SDK caches and
ultimately exceeded the CPU limit during profile validation, after collecting all
timing/counter rows. This harness defect was corrected by sharing an SDK cache
within full-body validation. Isolated pack results are recorded separately.

The isolated CF run uses the complete baseline engine on both sides, changing
only loose versus packed storage. Two warmups and eight paired trials all pass
full-body validation. Clone improves 1,985 → 1,327.5 ms (paired ratio 0.736,
95% interval [0.557, 0.793]); checkout improves 2,602 → 2,033 ms (0.821,
[0.722, 0.900]). Clone reads 75,239 → 22,080 SQL rows and writes
13,254 → 4,227. Unlike local SQLite, CF allocated storage shrinks
3,608,576 → 2,777,088 bytes, about 23%. Preparation costs 3,618 ms,
roughly six subsequent clones at these marginal medians to amortize.

Packing is useful for persistent, repeatedly cloned repositories. Automatic packing
remains off because a one-shot clone would become slower after including
preparation, and packing temporarily needs additional quota. No general automatic
trigger was established by this workload. Existing SDK maintenance and externally
packed repositories already support this format without new FS APIs. The measured
steady-state benefit is recorded, but no unconditional runtime packing is adopted.

## Copy-on-write feasibility prototype

A benchmark-only SQL prototype shared immutable chunk bodies through references.
For 1,000 files, raw directory-copy time fell from 3.37 to 2.92 ms and stored body
bytes fell from 1,706,880 to 853,440. This is a storage-layout probe, not a complete
POSIX filesystem implementation. After a source write returned success, reading
it still returned old data. Existing upsert/update, triggers, detached descriptors,
hard links and migration paths cannot be transparently replaced by that view.
The prototype failed local behavior validation and was not deployed or integrated.
The roughly 0.45 ms copy saving also bounds its immediate latency contribution to
this approximately 112 ms clone; a correct future storage redesign may still have
value for many persistent copies.

## Method and verification

Baseline: commit 103e8a8. Node v24.18.0, actual NodeSqlFileSystem. Standard local
cache measurements use two warmups and eight alternating pairs on 1,000 files;
large-tree tests use 5,000 files and four pairs, with the same raised I/O, step,
glob and mutation limits for both variants. Large-tree repeat status improves
176.68 → 126.19 ms, showing the 4,096-entry capacity does not cause total thrashing.
The local first/cold path and add-all remain roughly 2% slower at that size.

CF uses a private authenticated evaluation Worker with independent SQLite Durable
Objects and a collaborative wrapper. Baseline and candidate each bundle their
own complete FS/shell/error classes; early mixed-class attempts were invalid and
discarded. Compatibility date and engine version are held constant. The timed
cache run has one discarded warmup and eight alternating pairs, followed by a
separate metered profile pair. RPC wall time is measured in the front Worker
around the DO call; client network time is excluded. Default credentials are
unbound in this comparison, matching the benchmark host rather than the demo's
numeric account. Permission semantics are tested separately.

Each coding trial checks clean/dirty output, stages the changed files, commits,
checks out base and compares all 1,000 resulting bodies with committed Git blobs
outside the timed region. Body collection in validation shares a command-scoped
SDK cache. Isolated experiment rooms are cleared in finally blocks.

All 1,948 Node tests, 155 Workers integration tests, 46 POSIX comparisons, package
consumers, typechecks, lint, knip, execution limits, docs and 12 bundle presets pass.
New tests cover same-size edits with frozen time, mode changes, recreated files,
dangling symlink replacement, read permission after a root cache warmup, CRLF
conversion changes, unpublished document text, cross-filesystem token collisions,
and I/O/buffer limits on warm bodies. Previously deployed batch/quota/recovery
checks remain in the suites. An actual reset mid-checkout is not newly established
by these experiments.

## Reproduction

```sh
node bench/git-no-api-2026-10-10/prepare-baseline.mjs
npm run build
node bench/git-no-api-2026-10-10/compare-expanded.mjs bench/git-no-api-2026-10-10/baseline dist OUTPUT.json
node bench/git-no-api-2026-10-10/compare-large.mjs bench/git-no-api-2026-10-10/baseline dist OUTPUT.json
node bench/git-no-api-2026-10-10/pack.mjs bench/git-no-api-2026-10-10/baseline OUTPUT.json
node bench/git-no-api-2026-10-10/cow.mjs bench/git-no-api-2026-10-10/baseline OUTPUT.json
npx tsc -p bench/git-no-api-2026-10-10/tsconfig.json
npx wrangler deploy --config bench/git-no-api-2026-10-10/wrangler.jsonc
EXPANDED=1 SKIP_PACK=1 node bench/git-no-api-2026-10-10/run-cf.mjs OUTPUT.json
SKIP_CACHE=1 PACK_BASELINE=1 node bench/git-no-api-2026-10-10/run-cf.mjs OUTPUT.json
```

The isolated host requires EVALUATION_TOKEN in its Worker secret and an ignored
.dev.vars file. The baseline directory is generated and ignored; ordinary CI
checks also pass without it. Existing SDK pack maintenance is measured directly,
not exposed as a new shell command or public FS method.

## Public deployment

Accepted cache deployed to https://vfs.borca.ai/ as Worker version
48f5f213-ede8-4878-9102-9f607286a457, implementation
f2ec59c8c95a3fdccd911b9df7007991259a72a2dc0f2d6873c501994e1199aa.
The public numeric-account shell passed init/config/add/commit, repeated clean
status, same-size edit detection, checkout body verification and local clone.
Only the smoke test's own temporary directories were removed. Home, benchmarks,
health and benchmark-results endpoints returned HTTP 200. Evaluation rooms were
cleared after measurements; the temporary evaluation Worker was then removed.
