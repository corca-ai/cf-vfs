# Performance and benchmarks

The runtime optimizes for bounded memory, predictable failure, and cloud
backpressure before microbenchmark latency. Run `npm run bench` for the Node
in-memory SQLite scenarios, `npm run bench:do` for workerd/SQLite operation
metrics, or `npm run bench:all` for both. `npm run bench:check` applies the
regression guards used by the separately scheduled Performance workflow.
These commands are deliberately excluded from ordinary unit tests and
`npm run check`. The checked-in
[Node SQLite baseline](../bench/node-sql-baseline-2026-07-25.md) and
[Durable Object baseline](../bench/do-baseline-2026-07-24.md) and its
[structural-cost follow-up](../bench/do-baseline-2026-07-26.md), plus the
[write-path follow-up](../bench/do-baseline-2026-08-27.md), record their
environments and interpretation. The
[small-text workload follow-up](../bench/text-workload-optimizations-2026-08-28.md)
records the measured candidates retained and rejected for sub-10 KiB code and
Markdown editing.

The [September text-processing follow-up](../bench/text-processing-2026-09-05.md)
compares repeated regex searches and short-record processing against `fedaf0e`
on Node and local workerd. Run `npm run bench:text` for its Node workloads;
the matching workerd cases are included in `npm run bench:do` and `bench:check`.
Repeated searches advance directly through the source's code points and retain
UTF-16 capture offsets, avoiding whole-input arrays for every match. Short
ASCII byte counts avoid encoding; larger strings retain the native encoder.

The [second September pass](../bench/text-processing-follow-up-2026-09-05.md)
measures further gains against `6fa62a3`: validated exact-string patterns use
native string search, existence-only searches skip capture materialization,
and each NFA search reuses its own bounded thread objects. Sed validates plain
replacement strings in one piece. The shared workloads now include 72 KiB
records with repeated capture groups, and workerd averages ten executions per
sample to resolve the faster cases. Non-regex and non-literal controls remain
in the suite.

## Structural guards versus wall-clock benchmarks

The [extension API removal evaluation](../bench/extension-api-evaluation-2026-10-08.md)
compares the current aggregate, digest, range, pagination, batch, and unchanged-write
paths with simpler replacements after the POSIX improvements. Large-file and
large-directory benefits remain. Batch writes and unchanged-write suppression
also preserve contracts independent of latency, so no public API was removed.
Reproduce the Node comparisons with `npm run build` followed by
`node bench/extension-api-evaluation.mjs`.

The [string-write follow-up](../bench/extension-write-optimization-2026-10-08.md)
removes per-string asynchronous collection from `writeFiles`, shares the owned
UTF-8 buffer across chunk views, and hashes contiguous views without assembling
another buffer. Byte and stream inputs still snapshot their caller-owned data,
and batch publication still revalidates every path before committing.

The [September SQL follow-up](../bench/sql-optimizations-2026-09-05.md) measures
batch usage aggregation, synchronous string append, cursor seeking and find
filtering, and indexed maintenance scheduling. Its workerd cases run with
`npm run bench:do` and `npm run bench:check`, asserting statement and row costs.
`findPage()` retains scanned-row limits and cursor semantics; `find()` can use
a direct-child index and safe literal-name prefix/type prefilters. Arbitrary
glob patterns stay in the bounded JavaScript matcher.

Schema version 8 adds an expression index for the GC queue's effective due
time and a partial index for verification lease expiry. Scheduling reads one
minimum per active category. The report includes the extra index-write and
database-space costs rather than treating these reads as a free optimization.

Elapsed time is noisy enough that a small regression hides inside it, so the
gates split in two. Counted work — output chunks, SQL statements, rows read, and
whether applet resolution touches storage at all — is asserted in
`test/performance-guards.test.ts` and runs in `npm run check`. Worker bundle size
is asserted per preset against recorded budgets in
`test/fixtures/bundle-budgets.json` by `npm run test:tree-shaking`.

Cancellation, concurrent shells, R2 operation and range behavior, and memory
stay in `bench/`, where a broad ceiling and a checked-in baseline carry the
interpretation. Nothing counts JavaScript allocation directly.

## Comparing a change locally

```sh
npm run bench:compare -- --base origin/main --output /tmp/cf-vfs-comparison.json
```

The command resolves the baseline to a commit, archives it into a temporary
folder, and freshly compiles both baseline and current working tree with the
installed TypeScript compiler. It never trusts an existing `dist`. Separate
filesystems execute identical text and UTF-8 workloads in one Node process,
alternating baseline/candidate and candidate/baseline order. Defaults are ten
warmup pairs and forty measured pairs; `--warmups` and `--samples` override them.
Temporary baseline files are removed on completion or failure.

The report records commit identities, compiled JavaScript and lockfile hashes,
the working-tree diff hash, compiler and Node versions, machine, protocol hash,
command, raw paired durations, medians,
p10/p90, and a deterministic bootstrap interval for paired timing ratios.
A ratio above one means the candidate was slower. Timing is advisory: an
interval near one or a small difference needs repeated runs, preferably an
unchanged-code control (`--base HEAD` on a clean tree), before calling it a
regression. Module layout, JIT, GC, and background work can affect even identical code. Bootstrap intervals
describe the sampled run, not all machine or process variability.

Each sample checks expected output and identical SQL statements/returned rows;
a structural difference fails immediately and requires an explicit review of
the workload's cost model. `npm run test:bench-protocol` checks pairing,
statistics, and cost rejection in the normal verification gate. Existing
`npm run bench:check` Node/workerd cost gates remain required independently.

## Stream and storage cost model

Pipeline edges carry `Uint8Array` chunks through a small raw
`ReadableStream` pump with byte-sized high-water accounting. A writer waits
when its downstream queue is full, and cancellation wakes both sides. Stages
start concurrently; the runtime does not materialize a whole pipeline between
commands.

Small command output is coalesced into roughly 64 KiB writes to avoid one
promise/microtask per line. `test/performance-guards.test.ts` pins that
structurally: 20,000 records must reach the consumer in a handful of chunks
rather than one per record. It runs inside `npm run check`, because a counted
regression needs no benchmark environment to be believable. Text decoders preserve partial UTF-8 sequences
across source chunks. Utilities such as `cat`, byte `head`, and `wc` can remain
incremental. `sort`, `diff`, `join`, `patch`, atomic redirection, and whole-file
VFS commit buffer because their semantics require a barrier; separate byte,
line, record, and heap budgets bound that materialization.

Inline VFS reads are intentionally eager. SQLite's synchronous cursor is fully
consumed into at most 8 MiB before a stream is returned, establishing a stable
snapshot without holding a cursor or transaction across `await`. A string
write snapshots only its actual body size and commits without an asynchronous
boundary; it does not allocate a full 256 KiB slab for an 8 KiB input or repeat
path and POSIX validation when nothing could have interleaved. Buffers, typed
views, streams, and batches still revalidate after collection because view and
entry accessors can run caller code. All forms insert up to 33 chunks per
statement. Append reads and rewrites only the last partial chunk plus newly
added chunks in the same batches; earlier chunks stay inside SQLite. The batch
size uses 99 of Cloudflare's 100 bound parameters. A
same-size or growing overwrite UPSERTs retained chunk slots in place; only a
shrinking overwrite deletes the suffix that would otherwise remain. This
avoids paying once to delete each chunk and again to insert its replacement.
This is usually faster and simpler than a paged pull protocol at this size, but
concurrent snapshots and writes are capped by the instance-wide in-flight
budget.

A byte-ranged inline read is eager only for the chunks that intersect the
range, and SQLite trims the boundary chunks before they enter JavaScript. For
a single chunk of at most 16 KiB, the simpler point query wins; the VFS keeps
that query and exposes only the selected view, avoiding a measured 18–20%
`substr` regression on the common 8–10 KiB case. The returned stat still
describes the full file. On the structural guard, reading three bytes from a
four-chunk file lowers returned SQL rows from five to three (the entry, stored
chunk width, and one selected chunk); the same path powers `head -c` and
`tail -c`. `wc -c` reads one byte to retain
the ordinary permission and file-kind checks, then uses the transactionally
maintained full size, likewise lowering a four-chunk file from five rows to
three. Opaque `wc -c` remains streamed so an R2 transport failure is not hidden
by metadata.

The final workerd A/B, including stream creation and consumption, measured a
10 KiB file at 0.17 ms both whole and ranged. An uncached stored-layout lookup
on an 8 MiB file measured 6.6 ms whole versus 0.4 ms ranged (-93.9%); repeated
ranges at the same entry revision reuse that small layout value.

Repeated content hashing uses a revision-stamped SQLite cache rather than
moving and hashing the same body again. `digestFile()` and `skipIfUnchanged`
share it; no cache column is selected by ordinary metadata or read operations.
On actual workerd, a cold 8 KiB digest costs 3 statements, 3 rows read, and 1
row written, while a warm digest costs 1 statement, 1 row read, and no write.
The cache write changes no observable file metadata. In the 100-file Node
shell A/B, the previous `sha256sum` path cost 300 statements and 300 returned
rows on every run. The new cold path remains 300 statements but returns 200
rows, and the warm path costs 100 statements and 100 rows. Across 1, 8, and 10
KiB files, cold median time improved 16.7–22.0% and warm time improved
71.0–71.9%. The detailed method and 1,000-file results are recorded in the
[small-text workload follow-up](../bench/text-workload-optimizations-2026-08-28.md).

The shell preserves that property. `rm -r`, `mv`, and `cp -r` charge their
mutation budget from the entry count in one indexed subtree aggregate rather
than materializing the subtree through `find()`. `du` uses the logical-byte sum
from the same aggregate, so both paths cost a constant number of SQL statements
and allocate nothing per entry. A credential-bound view uses the permission
preflight appropriate to the mutation, so budgeting `mv` does not accidentally
require read permission on the source subtree. The charge and `du` result are
also exact above `find()`'s 10,000-result ceiling.

Two broader fusions were measured and deliberately not exposed as APIs. In
workerd, one SQL statement for 100 independent 8 KiB reads reduced median time
from 2 ms to 1 ms but raised billed rows from 299 to 399, while requiring all
100 bodies to be materialized before sequential utilities could consume them.
A fused 100-entry directory listing stayed at 0.3 ms and raised billed rows
from 101 to 201. The current per-file streaming order and two-statement listing
therefore remain preferable to lower statement count alone.

### POSIX credential cost

The trusted path has a hard zero-overhead SQL requirement. The workerd
regression suite records exactly 3,584 statements, 3,584 rows read, and 3,072
rows written for 512 root-level small writes; 4 statements/9 rows read/3 rows
written for an 8 KiB point overwrite; and 9/8/9 statements for subtree
copy/move/remove. A root-level creation relies on the schema's permanent root
invariant instead of reading `/` again, and the pre-stream/commit checks read a
live entry or absent-path tombstone in one statement.

A credential-bound point or directory operation adds one indexed ancestor
query per path it resolves. A guarded listing test records exactly two more
statements than the trusted listing (operand classification and listing each
check their ancestors); changing the directory from 200 to 400 entries changes
rows only, not statements. Materializing `find()` permission-preflights once
across all pages: a 1,006-entry, two-page traversal is pinned at five
statements rather than repeating the range preflight per page. A
credential-bound recursive copy is pinned at 14 statements for both 41-entry
and 81-entry source trees; its setgid calculation grows in rows, not statement
round trips. Creating an entry below an existing parent costs 9/9/10/12
statements for touch/mkdir/symlink/write, and a touch that creates three
intermediate directories costs 21; each transaction walks its parent chain
only once.

Ownership columns and the permission engine do increase deployed code size.
Against the `main` worktree baseline, the raw VFS preset moved from
99,392 to 126,520 bytes (+27,128), the R2 preset from 102,003 to 129,131 bytes
(+27,128), and the Linux profile from 525,211 to 558,043 bytes (+32,832).
The shell-only preset, which does not carry SQLite, moved from 221,110 to
223,494 bytes (+2,384). These measured values were recorded with the standard
five-percent headroom in `bundle-budgets.json`; the increase is the explicit
cost of making the SQL VFS permission-capable, not an unreviewed budget drift.

Optional account-name resolution remains outside the VFS and therefore leaves
the raw VFS, R2, and small two-applet command presets unchanged at
126,520/129,131/15,755 bytes. Against permission-capable commit `97800a8`, the
standalone name-aware `ls` applet moves from 11,555 to 15,700 bytes (+4,145);
the one-applet shell executor moves from 223,494 to 224,251 (+757); and the
default and Linux presets move from 437,181/558,043 to 448,678/569,540
(+11,497 each). The resolver implementation is asserted absent from presets
that do not retain an identity-aware applet. A 1,000-entry `ls -l` remains
three SQL statements and 1,002 returned rows with or without a resolver;
identity mapping is one deduplicated host call rather than an SQL query or an
entry-by-entry callback.

Opaque work is payload-size-independent inside the metadata DO. Upload/download
bytes go directly to R2; the DO performs metadata SQL plus one R2 `HEAD` during
commit. Recursive copy, move, and remove use a constant number of SQL statements
instead of one statement sequence per entry. Inline copy keeps BLOBs inside
SQLite through `INSERT ... SELECT`; copy and move perform no R2 body operation.
GC batches up to 100 keys into one idempotent delete request.

R2 remains the capacity and direct-transfer tier when workspace bodies would
outgrow one Durable Object. The benchmarks do not infer an automatic
SQLite-to-R2 size threshold because the two content classes have different
capacity, streaming, shell-access, and lifecycle semantics.

## Covered scenarios

The executable benchmark covers:

- 1 KiB, 64 KiB, 1 MiB, and 8 MiB inline write/materialize/read;
- a 1 MiB inline overwrite;
- one-, three-, and six-stage 1 MiB pipelines;
- 16,384 one-byte chunks;
- a 1 MiB line through a buffering utility;
- early downstream cancellation and a deliberately slow 64-chunk consumer;
- four concurrent shell executions;
- 1 MiB opaque begin/put/`HEAD`/commit/unlink/GC; and
- a 64-object GC batch.

Each Node row records median elapsed time after a warm-up, three measured
repeats, heap/ArrayBuffer/external/RSS high-water deltas, output bytes, backend,
SQL fields, logical R2 Class A/B/free-delete operations, and a
marginal Standard-storage operation-cost estimate. SQL fields are explicitly
`null` because Node's SQLite API does not expose Cloudflare cursor billing
metrics; the separate workerd benchmark measures those fields. Unlike the
removed Map backend, these scenarios execute the production schema and VFS SQL.

The separate workerd storage benchmark meters statements,
`SqlStorageCursor.rowsRead` and `rowsWritten`, cursor consumption methods,
`databaseSize`, physical inline chunk count, and amortized local latency. It
covers 512 randomly read 8–12 KiB BLOBs and their storage amplification,
a 1 MiB overwrite plus snapshot, the 1/33/34-chunk SQL batch boundary, 1 MiB
and 8 MiB tail-only append, point reads and overwrites, filtered scans, warm
schema initialization, and set-based subtree copy/move/remove at multiple
sizes. The subtree guard pins both statements and move rows read so an
aggregate pre-scan cannot return unnoticed. Cursor metrics are the platform
billing-oriented values; diagnostic SQL used to inspect a result is deliberately
outside that meter.

Stable structural guards, rather than tight wall-clock thresholds, fail the
benchmark when a point query stops fully consuming its cursor, an overwrite
adds SQL/row work, append starts rewriting size-proportional chunks, or
recursive namespace operations return to per-entry SQL calls. Latencies remain
visible for trend comparison because local and hosted-runner timing is noisy.

## Deployed benchmark

`wrangler.benchmark.jsonc` deploys the independently hosted `cf-vfs-benchmark`
Worker to `vfs.borca.ai`. The Worker serves the interactive browser demo at
`/`, upgrades `/ws` to one SQLite-backed `DemoWorkspace` Durable Object per
browser workspace, and retains the authenticated benchmark at `/benchmark`.
`DemoWorkspace` and `VfsBenchmark` use separate bindings, classes, object IDs,
and SQLite databases even though one Worker routes both entry points.

The deployed Worker does not publish the npm package or reuse an application's
Durable Object namespace. Its `bench/` and `demo/` sources are outside both
`tsconfig.build.json` and the package's `files` allowlist, so a deployment does
not add the terminal or benchmark code to the library bundle.

The public `/health` route performs no storage work. `POST /benchmark` still
requires the `BENCHMARK_TOKEN` secret and accepts only the bounded `quick` and
`full` profiles. Every benchmark run uses a new `VfsBenchmark` Durable Object
ID and calls `deleteAll()` before returning, so benchmark contents are not
retained. Demo files remain only in their separately routed `DemoWorkspace`.

Production Workers intentionally freeze `performance.now()` and `Date.now()`
between I/O events. This affects the runtime as well as measurement; see
[the deadline note](operations.md#execution-budgets). The deployed benchmark
therefore measures each operation
at the calling Worker across a Durable Object RPC boundary, rather than
pretending an in-object synchronous timer is meaningful. Fast point operations
are batched and reported as amortized per-operation values. Append and subtree
mutations use one operation per RPC and include Cloudflare-internal RPC plus
storage input/output-gate latency. The response also reports an empty-RPC
control and total Worker-to-DO suite time; `bench/remote.mjs` adds the external
client round-trip. See Cloudflare's
[timer behavior](https://developers.cloudflare.com/workers/runtime-apis/performance/)
and the checked-in deployed baselines:
[core operations](../bench/remote-baseline-2026-07-24.md) and
[opaque body reads](../bench/remote-baseline-2026-07-26.md).

The opaque section needs an R2 bucket bound to the benchmark Worker and is
omitted when there is none. It measures what the local tests cannot: R2
operation count, SQL cost against a real lease, the chunk size R2 actually
delivers, and Durable Object time for a read it is relaying. First-byte latency
is reported but varies more between runs than between body sizes — it is a
network measurement, not a regression signal.

Keep the secret outside version control:

```sh
npx wrangler secret put BENCHMARK_TOKEN --config wrangler.benchmark.jsonc
CF_VFS_BENCHMARK_TOKEN=... npm run bench:remote
```

For repeated local runs, `.dev.vars.benchmark` may contain
`BENCHMARK_TOKEN=...`; `.dev.vars*` is ignored. `npm run bench:remote:check`
compares stable SQL costs exactly and applies deliberately broad production
latency ceilings against the checked-in deployed baseline. A custom domain is
appropriate here because the Worker is the origin. Do not attach this config
to an existing hostname or application Worker.

## Interpreting the baseline

Local timings are regression evidence, not production latency. Even separate
Node heap, ArrayBuffer, external, and RSS samples can miss synchronous peaks,
and garbage collection can make an observed delta zero. Worker
isolate allocation, DO duration, RPC/edge latency, R2 network time, cold starts,
and concurrent tenants require deployed measurements.

The billing estimates use rates current on 2026-07-20 and show marginal cost
after included usage; they exclude storage duration, DO requests/duration,
Worker cost, multipart requests, retries, and Infrequent Access retrieval or
minimum-duration fees. R2 `PutObject` is Class A, `HeadObject`/`GetObject` are
Class B, and deletes are free according to [R2
pricing](https://developers.cloudflare.com/r2/pricing/). SQLite rows and stored
data follow [Durable Object
pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Durable Object SQL

`sql.exec()` is synchronous because SQLite is embedded beside the object,
without a database network round trip. Keep cursors synchronous and fully
consumed, and keep related mutations in `transactionSync()`. External R2 or
network I/O must occur after that transaction. Cloudflare's output gate handles
durability before external messages are released.

Repeated indexed statements are not free: CPU, rows visited, index updates,
database bytes, and time on the object's single thread still matter. Review
rows and bytes rather than statement count alone. Prefer pagination and range
scans for large namespaces, and use deployed analytics for billed rows.
Namespace reads anchor `vfs_entries` to an operation-appropriate named index
before joining path versions. This prevents SQLite from choosing the compact
`WITHOUT ROWID` token table first and scanning every entry for a point lookup;
the benchmark guards a populated `stat()` at two rows read.

Current platform constraints include a finite per-object SQLite capacity, a
128 MiB Worker isolate memory limit, SQL value/statement limits, and separate
CPU/request limits. R2 has different single-part, multipart, and same-key write
constraints. Verify changing values in [Durable Object
limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
and [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) before
deployment.

## POSIX performance experiments

The [current Git filesystem comparison](../bench/git-current-comparison-2026-10-08.md)
runs the same isomorphic-git engine on native APFS and the current Node VFS.
Trace-free timing uses 1,000 and 10,000 files; separate instrumented diagnostics
also include 100 files. It records seven matched trials after two warmups,
uncached and optional cached adapters, a larger-cache follow-up, and byte-for-byte
clone verification. These are local in-memory SQLite measurements; they do not
include Durable Object RPC or R2 network latency.

The [POSIX experiment report](../bench/posix-evaluation-2026-10-08.md) compares
native Linux files with the VFS, records all ten independent trials, and keeps
their raw measurements and rejected prototypes. Run `npm run bench:posix` for
fresh profiles and `npm run test:posix` for the recorded Linux semantic oracle.
The oracle checks return values, error codes, and post-operation namespace and
content. The completion work removed the six recorded differences; the current
oracle covers 46 traces. It is part of `npm run check`.

Credential-bound stat combines target and ancestor metadata into one SQL
statement when no symlinks exist. It preserves search permission checks and
uses the existing path for symlinks and trailing slashes. This reduces statement
and cursor overhead; it does not reduce SQLite's billed rows. Replacement
rename reuses the destination row already read in its synchronous transaction.
The Node testing adapter additionally reuses at most 256 prepared statements
per database; its latency gains do not describe Cloudflare's SQL implementation.
The workerd cost guards run under `npm run bench:check`.

The [path resolution follow-up](../bench/posix-path-fix-2026-10-08.md) fixes dot
components in direct VFS and promise-FS paths without a storage migration.
Paired profiling alternates two builds in separate processes to avoid
module identity and allocator bias. `POSIX_REPEAT_FACTOR=10` lengthens repeated
operations; one-shot operations retain their original repetition count:

```sh
POSIX_COMPARE_LIBRARY=/path/to/baseline/dist POSIX_TRIALS=15 npm run bench:posix
```

The [POSIX completion evaluation](../bench/posix-completion-2026-10-08.md)
adds shared inode handles, hard links, ctime and parent timestamp semantics.
Namespace transactions now pay one indexed parent metadata UPDATE; batching
amortizes it. The report separates this required cost from read/overwrite
profiles, and records independent review fixes and immutable-store limits.


The [five-trial follow-up](../bench/posix-perf-five-2026-10-08.md) retains POSIX
semantics while removing repeated inode reads, per-chunk shrinking deletes,
discarded full-chunk reads, unnecessary parent nlink recounts and unshared alias
lookups. Inode rows are reused only inside an operation, not cached between
operations. Transactions containing directory namespace changes conservatively
keep parent nlink recounting; file-only namespace transactions skip it.

`bench/posix-perf-five.mjs` measures dedicated workloads in alternating isolated
processes. `PERF_BEFORE=/path/to/baseline/dist PERF_LIBRARY=dist PERF_TRIALS=9
PERF_OUTPUT=/tmp/five.json node bench/posix-perf-five.mjs` records timings, paired
ratios and returned rows/BLOB bytes. These are Node adapter measurements; the
workerd benchmark separately guards statements and billed rows under
`npm run bench:check`. Truncate still deletes every removed storage row, and
partial boundary writes still read the bytes they must preserve.


The [public Cloudflare evaluation](../bench/public-benchmark-evaluation-2026-10-08.md)
records the deployed file/Git workload at `https://vfs.borca.ai/benchmarks/`.
Its saved result is refreshed only on an explicit request once the VFS result
file is at least ten minutes old. Durable alarms and VFS checkpoints let a run
continue without an open browser. The report distinguishes local metadata
reuse gains, rejected checkout candidates, production RPC timings and the
Git compression concurrency needed to fit a real isolate.

Each displayed median and cache ratio has a sparkline for up to ten distinct
commits. A successful rerun replaces that commit's point in place, so repeated
requests cannot fill the window. Compact history is saved atomically with the
latest result in `/benchmarks/trends.json`; failed runs do not add points.
Existing retained runs without commit metadata are deduplicated by build (or
Worker deployment) and explicitly labelled legacy. Unidentifiable results are
not assigned invented versions. Trends match group, operation, file count,
cache setting and operation count; timing noise and workload changes still
matter when interpreting the first-to-last percentage. Opening the page reads
saved history and does not execute a benchmark. Deploy committed source with
`npm run deploy:public` to record its Git SHA alongside the source fingerprint.


For iterative production optimization, use the authenticated public-suite
workflow in [the demo README](../demo/README.md#repeated-production-performance-evaluation).
Capture a baseline, change one measured bottleneck, run correctness checks,
deploy, and compare raw CF samples using `npm run bench:public`. Keep an
implementation change only when representative repeated production measurements
support it; a single noisy three-sample ratio is insufficient. Results identify
the deployed Worker version, and deployment changes interrupt in-flight runs
instead of combining samples from different implementations. Public requests
continue to observe the ten-minute VFS mtime cache; authenticated evaluation can
request a fresh run immediately.

The [ten-round production evaluation](../bench/cf-optimization-2026-10-08/report.md)
archives every candidate and actual CF run, including rejected optimizations.
Worker and Durable Object source fingerprints prevent measurements from mixing
implementations while deployment propagates. Smaller SQL call counts can have
higher billed row costs; the report records both. Chunk-size reconfiguration
regressions have dedicated byte, snapshot and hard-link tests, and POSIX
comparison remains 46/46.

The [two-hour Git and filesystem evaluation](../bench/cf-improvement-2026-10-09/report.md)
records selected-path staging, bounded removal staging, command-local missing
ignore probes, default-mode Git writes and exact single-file removal. It also
compares unchanged local pull on CF and records the remaining local checkout
gap against the actual filesystem. The public suite separates shell Git from
direct-engine Git so applet improvements are measured directly.

The [whole-worktree Git add evaluation](../bench/git-add-optimization-2026-10-09/report.md)
compares new-blob inspection, small-body staging batches, overlapping config
reads and bounded body/hash inspection without adding filesystem APIs. It
records ten actual CF evaluations, rejected probes, unchanged bundle budgets,
exact logical I/O accounting and remaining timing outliers.

The [Git add follow-up](../bench/git-add-next-2026-10-09/report.md) separates actual
CF inspection/staging wall times, index serialization and command-local body/hash
reuse. Larger compression batches and body/hash caches are rejected. Deletion-only
staging reduces index serialization for up to 1,024 paths without retaining bodies;
the report records alternating CF controls and the small-buffer cache regression.

The [Git API experiments](../bench/git-api-experiments-2026-10-09/report.md)
compare bounded one-serialization engine staging, loose-object `writeFiles`
and multi-path metadata queries. Only object batching is retained, with advisory
backend buffer headroom and small-set fallback. The new capacity property is
optional; it does not alter POSIX operations, atomic write semantics or quotas.

The [POSIX API follow-up](../bench/posix-api-2026-10-10/report.md) compares deep
permission checks, small append, parent link-count maintenance and empty
directory removal against `6ced964`, with local and actual CF measurements.
Public API and persisted schemas stay unchanged; ordinary stat, overwrite,
and rename remain controls; deep traversal candidates were rejected.
