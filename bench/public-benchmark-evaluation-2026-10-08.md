# Internal metadata optimization and public Cloudflare benchmarks — 2026-10-08

The deployed page is <https://vfs.borca.ai/benchmarks/>, linked from the existing
shell demo. It runs real file and local Git operations on Durable Object SQLite,
saves the successful result in its own VFS, and shows that saved result on page
load. It adds no filesystem library API.

## Retained internal change

An existing inline content overwrite no longer discards every warmed metadata
entry. It invalidates its path and all announced hard-link aliases. Namespace
and metadata changes still clear everything, retaining ancestor permission,
link traversal and subtree correctness. The cache is still bound to one
filesystem/credential view, errors/bytes are not cached, and complete committed
mutation event delivery is still required.

If an entry has been evicted since the last clear, content writes also clear
the cache. An oversized sequential working set would otherwise retain a tail
that the next scan evicts before reaching it. This preserves the original
behavior for the 10,000-file Git workload with a 4,096-entry cache.

A focused workload lists/warm-caches metadata, overwrites one existing file,
then times lstat for all files. It uses three warmups, 21 matched trials,
alternating version order, and the same integer SQL observer on both versions.
The overwrite itself is outside this local timer. Results:

| Files | Before (ms) | After (ms) | Paired ratio | SQL statements before → after |
|---:|---:|---:|---:|---:|
| 1,000 | 4.677 | 0.250 | 0.052× | 1,000 → 1 |
| 4,096 | 18.982 | 1.000 | 0.053× | 4,096 → 1 |

This is approximately 95% less time for that warmed metadata-only readback,
not a claim that Git or complete filesystem writes become 95% faster.
[Raw samples](metadata-overwrite-results.json) and the
[reproducible comparison](metadata-overwrite-compare.mjs) are included.

The builds use Node v24.18.0 on Apple M5 Max / APFS, with the previous string
collection/digest improvements present in both. The baseline is the saved
pre-cache-change `dist` at `/tmp/cf-vfs-checkout-before-dist`; its original
metadata implementation is also in the source HEAD recorded by the Git raw
files. The candidate is `/tmp/cf-vfs-checkout-adaptive-dist`. Reproduce using:

```sh
node bench/metadata-overwrite-compare.mjs BEFORE_DIST AFTER_DIST OUTPUT.json
```

## Checkout candidates and limits

Content-only invalidation did not produce a convincing additional checkout
improvement. Broader subtree invalidation was tried with a scan, a per-ancestor
index, and a shallow index. Each preserved tested permissions, but indexing
and cache retention increased costs when the repository exceeded cache capacity.
These candidates were rejected; no subtree index or enlarged default cache
remains in the library.

Seven matched native/VFS trials after two warmup pairs on 10,000 files, with
filesystem/SQL tracing disabled, give the following medians. Each version is a
separate run; native/VFS order alternates within it. This is diagnostic evidence
of no material retained checkout gain, rather than a strong paired-version
speed claim:

| Operation | Original cache (ms) | Retained adaptive cache (ms) |
|---|---:|---:|
| checkout-old | 307.73 | 314.08 |
| checkout-main | 310.10 | 313.23 |
| status-clean-2 | 196.04 | 197.16 |
| status-one-change | 227.09 | 229.61 |
| add-all | 1546.66 | 1557.85 |
| clone | 1399.04 | 1426.72 |

The rejected per-ancestor index raised checkout-main from roughly 310 ms to
409 ms; avoiding repeated path normalization reduced that to 351 ms, and a
shallow index to 318 ms. The final implementation keeps the simple cache and
uses full invalidation after capacity eviction. Some exploratory local runs
overlapped brief tests/builds; do not interpret small sequential differences
as statistically established gains or regressions. The final adaptive run and
original run have similar native-normalized checkout costs.

Evidence: [original 10k raw](checkout-10k-before-2026-10-08.json.gz),
[rejected ancestor index](checkout-10k-after-2026-10-08.json.gz),
[rejected canonical index](checkout-canonical-2026-10-08.json.gz),
[rejected shallow index](checkout-partitioned-final-2026-10-08.json.gz),
[content-only run](checkout-accepted-2026-10-08.json.gz), and
[retained adaptive run](checkout-adaptive-2026-10-08.json.gz).

## Actual Cloudflare execution

The final public suite has 88 result rows: 100/1,000 files, cache off/on,
nine file operations and thirteen Git operations. Each row contains three
samples after one complete warmup; cache order alternates by trial. Bodies are
approximately 0.8 KiB. Every final worktree/file body is checked before results
are published. The successful alarm-backed run completed 18,096 checks.

Representative 1,000-file medians from the saved production run:

| Operation | VFS (ms) | Metadata cache (ms) |
|---|---:|---:|
| stat | 12 | 6 |
| stat-after-overwrite | 87 | 60 |
| read | 13 | 8 |
| add-all | 3812 | 4515 |
| status-clean | 52 | 28 |
| status-change | 136 | 88 |
| checkout-main | 162 | 129 |

Unlike the local metadata comparison, stat-after-overwrite includes the write,
its storage effects and the DO RPC. The current production medians are therefore
not directly comparable to the local metadata-only timings.

Production variability is substantial: the cached 1,000-file write samples
were 85, 1,037 and 2,189 ms, while the uncached samples were 116–151 ms. That
operation does not read the metadata cache. Three samples cannot establish
that the cache causes the difference. The UI shows min/max and raw samples are
available; use repeated refreshed runs before drawing broader conclusions.

[Saved production result](public-benchmark-cloudflare-2026-10-08.json) records
run ID `d45cb133-f310-4b5a-8c09-e1e8096254ac`. Its request colo is LAX; this is
not the DO's location. The run used deployment
`d4c1b7cf-9a1c-45b6-8a89-41477a2b5e82`. The final deployment
`17fc79fd-9c08-419a-ace0-83431c53790f` adds progress reporting, publication
coordination and the overflow fallback; the 1,000-file workload does not overflow the cache. The cached result
intentionally survives deployments and is reused until its mtime expires.

An earlier [foreground run](public-benchmark-cloudflare-before-2026-10-08.json)
completed 18,080 checks with the original cache. Its orchestration and row set
differ: it ran from the HTTP Worker instead of the alarm-invoked timing service,
and omitted stat-after-overwrite. Do not treat its absolute latency difference
as an isolated cache optimization measurement.

### Timer and memory constraints discovered in deployment

Production Cloudflare clocks advance after I/O, so timing synchronous SQL
inside the DO can report zero. A named `BenchmarkRunner` Worker entrypoint
measures each DO RPC instead. Calls include dispatch, assertions, storage and
coordination. Full-body validation and final teardown are not timed. Short
operations can still round to zero; the UI does not compute ratios for zeros.
This is an RPC wall-time benchmark, not isolated CPU time, APFS performance,
or native Git CLI performance. R2 and Git push/clone networking are excluded.
See [Cloudflare's timer documentation](https://developers.cloudflare.com/workers/runtime-apis/performance/).

A first production attempt with `git.add({ filepath: "." })` hit the isolate
memory limit at 1,000 files. The Node-compatible Git build opens concurrent
zlib compressors. The public workload now stages all files in batches of 32
using Git's existing filepath-array API; no VFS API was added. Both columns use
that same bounded workload, explicitly labelled in the UI. Production runs
then completed successfully. This proves the selected workload fits; it does
not establish peak-memory numbers or support arbitrary repositories.

## On-demand persistence and deployment validation

- GET reads the saved VFS result and never claims a benchmark.
- POST before `latest.json.modifiedAtMs + 600_000` returns the same result,
  run ID and modification time. At the boundary a request can start a new run.
- Concurrent requests coalesce behind a persisted VFS run lease. A running
  request returns 202; the previous successful result stays visible.
- Durable Object alarms advance one workload group at a time. The next index,
  partial samples and verification totals are VFS checkpoints. Closing the
  browser does not cancel the job; an interrupted group can rerun its setup.
- The lease renews at checkpoints. Stale owners cannot mutate a newer job's
  scratch directory or publish its result. Failures retain the previous result.
- There is no periodic rerun, user-controlled size/script/remote, or access to
  the terminal's country workspace. The older private `/benchmark` API keeps
  its bearer authentication.

Production validation used the actual public endpoint and browser:
concurrent POST returned 202/shared, repeated requests inside ten minutes kept
mtime/run ID, results survived a Worker deployment, and a request after ten
minutes started a new run. The browser was closed while alarms continued; the
new result was subsequently read and contained all 88 rows / three samples
and 18,096 checks. Further requests reuse that result.

Node tests cover the exact ten-minute boundary, concurrent claims, eviction
reconstruction, expired/stale publishers, failure retention, checkpoints and
lease renewal, and real file/Git operations with both cache settings. Cache
tests cover overwrite reuse, hard links, ancestor/root permission changes,
symlink repoints, views, eviction and deep paths. The normal library verification
and performance/bundle guards are run without changing their budgets.
