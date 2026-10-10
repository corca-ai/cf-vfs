# Current Git: native FS versus VFS — 2026-10-08

**Use the trace-free results in this report for latency comparisons.** The
current VFS completes the measured Git-operation workflow about 5–12% faster
than local native FS, depending on repository size and cache configuration.
Checkout remains materially slower. Clone is approximately tied at 1,000 files
with the default cache, and a few percent slower at 10,000 files.

## Method

The same **isomorphic-git 1.43.1** engine runs on both backends. This
isolates the choice of filesystem under the JS engine; it is not a comparison
with the speed of the native `git` CLI.

- Native FS: Node promise FS on local APFS SSD (`/System/Volumes/Data`).
- VFS: current public `createFsAdapter` on NodeSqlFileSystem's **in-memory**
  SQLite, including the preceding string-write improvements.
- Environment: Apple M5 Max, darwin/arm64, Node v24.18.0.
- Fresh local smart-HTTP bare remotes use git version 2.50.1 (Apple Git-155).
- Source: `78d7da1e6ee7d913319ec12736733a66648c623b` plus the source diff saved in raw artifacts.
  The library was built before measurements; no library changes, builds, or
  test suites ran concurrently with timed work.
- 1,000 and 10,000 tracked files, 100 files per directory, approximately 0.8 KiB
  of deterministic text per file. Each run starts with fresh working and remote
  repositories. Modules and OS caches are warm; caches are not forcibly flushed.
- Two complete warmup pairs and **seven measured pairs** per setting and size.
  Order alternates native/VFS and VFS/native. Each setting has its own matched
  native control, so compare paired ratios rather than absolute times from
  different sessions.

Settings are uncached public adapter, optional default 4,096-entry metadata cache
with the content tier, and the same optional setup with 16,384 cache entries
(10,000 files only). The library default was not changed. All measured small-text
Git bodies fit the 8 MiB inline ceiling. The optional store is MemoryOpaqueStore;
this does not measure R2 body transfer.

### Why tracing was disabled for the final timings

The original harness records FS calls, failures, and normalized SQL query text.
Those observations add asymmetric work: SQL logging exists only on VFS, while
native FS can record many ENOENT retries during parallel object creation. They
were sufficient to change some apparent performance conclusions. The final
`GIT_PROBE_TIMING_ONLY=1` mode passes the public FS objects directly to Git and
omits the SQL observer; counters are collected in a separate diagnostic run.

For example, at 1,000 files the instrumented uncached clone appeared about 14%
slower than native, while the trace-free paired ratio is 0.940, about 6% faster.
These are separate matched runs, not an exact isolated subtraction of tracing
cost, but the reversal makes the diagnostic timings unsuitable as headline
backend latency. [Instrumented measurements](git-current-instrumented-comparison-2026-10-08.md)
remain available for SQL and call analysis, including the original 100-file case.

The rerun also decodes Uint8Array diff inputs explicitly as UTF-8 (rather than
its numeric `toString()`), and records time before meter serialization. Old
reports are historical context rather than exact implementation A/B baselines.

## Workflow totals

The total is the sum of **14 common timed Git steps**: add-all, initial commit,
three clean statuses, changed-file status, one-file diff, add-one, commit-one,
branch creation, two checkouts, push, and clone. File population, initialization,
the edit itself, remote setup, and final whole-clone body verification are
excluded. It is a workload-weighted total, not a universal Git throughput score.
Operation-specific assertions inside each timed step remain included on both
sides. Individual/bulk add of 20 tracked paths at 1,000 files is measured
separately and excluded from this common total.

Times are independent medians in ms. Ratio is the median of matched per-trial
VFS/native ratios, so it need not equal the quotient of the two time medians.
Intervals are deterministic paired-bootstrap 95% intervals.

| Setting | Files | Native ms | VFS ms | Paired VFS/native | 95% interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| uncached | 1,000 | 586.12 | 551.63 | 0.944 | 0.932–0.956 |
| uncached | 10,000 | 6557.54 | 5880.40 | 0.920 | 0.897–0.928 |
| cached-tiered | 1,000 | 581.73 | 502.51 | 0.884 | 0.859–0.891 |
| cached-tiered | 10,000 | 6544.31 | 6063.04 | 0.954 | 0.927–0.963 |
| cached-large | 10,000 | 6084.38 | 5560.00 | 0.918 | 0.911–0.932 |

## uncached: 1,000 files

Clean status is the third scan; checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| add-all | 137.12 | 125.45 | 0.918 | 0.884–0.941 |
| commit-one | 3.33 | 2.75 | 0.837 | 0.804–0.866 |
| status-clean-2 | 19.07 | 20.03 | 1.041 | 1.026–1.084 |
| diff-one-change | 19.98 | 21.15 | 1.059 | 1.040–1.072 |
| checkout-main | 17.91 | 28.04 | 1.654 | 1.560–1.659 |
| push | 167.59 | 132.12 | 0.779 | 0.771–0.806 |
| clone | 137.58 | 127.65 | 0.940 | 0.901–0.993 |

## uncached: 10,000 files

Clean status is the third scan; checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| add-all | 1927.66 | 1578.53 | 0.841 | 0.821–0.857 |
| commit-one | 24.88 | 24.44 | 0.978 | 0.926–0.982 |
| status-clean-2 | 217.07 | 196.47 | 0.900 | 0.892–0.915 |
| diff-one-change | 216.93 | 210.30 | 0.965 | 0.960–0.971 |
| checkout-main | 166.74 | 262.49 | 1.574 | 1.565–1.594 |
| push | 1547.62 | 1077.96 | 0.732 | 0.701–0.744 |
| clone | 1562.35 | 1609.91 | 1.030 | 1.027–1.090 |

## cached-tiered: 1,000 files

Clean status is the third scan; checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| add-all | 134.82 | 129.32 | 0.971 | 0.953–0.981 |
| commit-one | 3.37 | 2.90 | 0.841 | 0.829–0.893 |
| status-clean-2 | 18.76 | 12.25 | 0.670 | 0.620–0.686 |
| diff-one-change | 20.17 | 13.26 | 0.654 | 0.643–0.673 |
| checkout-main | 17.41 | 19.66 | 1.130 | 1.067–1.186 |
| push | 170.96 | 132.41 | 0.775 | 0.767–0.801 |
| clone | 131.92 | 131.49 | 1.009 | 0.991–1.084 |

## cached-tiered: 10,000 files

Clean status is the third scan; checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| add-all | 1949.98 | 1654.25 | 0.875 | 0.873–0.907 |
| commit-one | 24.23 | 23.81 | 1.009 | 0.979–1.014 |
| status-clean-2 | 215.97 | 195.21 | 0.904 | 0.896–0.929 |
| diff-one-change | 215.87 | 230.36 | 1.067 | 1.042–1.084 |
| checkout-main | 168.66 | 310.48 | 1.857 | 1.832–1.873 |
| push | 1496.45 | 1056.14 | 0.714 | 0.706–0.720 |
| clone | 1579.41 | 1602.89 | 1.019 | 1.011–1.109 |

## cached-large: 10,000 files

Clean status is the third scan; checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| add-all | 1795.28 | 1474.97 | 0.825 | 0.822–0.854 |
| commit-one | 24.12 | 23.37 | 0.976 | 0.962–0.977 |
| status-clean-2 | 215.49 | 181.38 | 0.840 | 0.835–0.853 |
| diff-one-change | 215.54 | 246.17 | 1.143 | 1.141–1.153 |
| checkout-main | 167.44 | 241.67 | 1.451 | 1.431–1.455 |
| push | 1404.44 | 1010.26 | 0.722 | 0.719–0.748 |
| clone | 1383.31 | 1412.85 | 1.025 | 1.009–1.077 |

## Interpretation

- **The current VFS does not impose a blanket Git penalty locally.** Without
  optional caching the Git-only total is about 6% faster at 1,000 files and 8%
  faster at 10,000. The default optional cache makes the 1,000-file workflow
  about 12% faster than its native control. Default caching at 10,000 files
  gives only about 5% overall advantage; the larger cache gives about 8%.
- **Checkout is still the strongest gap.** Uncached checkout is about 65%
  slower at 1,000 files and 57% slower at 10,000. The default cache reduces the
  1,000-file gap to 13%, but the 10,000-file gap is about 86%. The 16,384-entry
  cache reduces that latter gap to about 45%, not parity.
- **Clone is close to native, not the large slowdown suggested by tracing.**
  Uncached clone is about 6% faster at 1,000 files; default-cached clone's
  interval crosses 1 and is treated as tied. At 10,000 files clone is about
  2–3% slower, with some sample variability.
- **Metadata caching helps repeated clean reads, but not every mutation.**
  At 1,000 files, default-cached status and one-file diff are about 33–35%
  faster than native. At 10,000, default clean status is about 10% faster, but
  one-file diff is about 7% slower. A larger cache improves clean status to
  about 16% faster, while diff is about 14% slower. Mutations invalidate the
  cache, so increased capacity is not a universal speed switch.
- **Push favors this in-memory setup.** It is about 22% faster at 1,000 files
  and 27–29% faster at 10,000 across matched settings. Native per-file promise
  I/O, synchronous SQLite access, common pack work, and localhost transport are
  all included; this is not a prediction of production DO/R2 latency.
- **Do not credit all of these gains to the immediately preceding string
  optimization.** Git objects/indexes generally arrive as byte buffers. This
  compares the current full backends, not a before/after library-change pair.

## Separate diagnostic SQL evidence

These counts come from instrumented runs, **not the trace-free timing run**.
Node SQL statement counts include BEGIN/COMMIT; returned rows are not Cloudflare
billed rows. Even a cached traversal still lists the complete namespace.

| Setting | Files | Clean-status statements | Returned rows | Checkout statements |
| --- | ---: | ---: | ---: | ---: |
| uncached | 1,000 | 2075 | 3079 | 2912 |
| uncached | 10,000 | 20525 | 30532 | 21470 |
| cached-tiered | 1,000 | 62 | 1066 | 619 |
| cached-tiered | 10,000 | 10424 | 20431 | 21109 |
| cached-large | 10,000 | 422 | 10429 | 10992 |

At 10,000 files, increasing cache capacity reduces clean-status statements from
10,424 to 422, but there are still 10,429 returned rows and substantial Git-side
work. That is consistent with a modest latency improvement rather than a 25×
end-to-end gain. A CPU or memory profile was not taken; no particular JS function
is assigned the remaining cost.

In one 10,000-file diagnostic add-all, native FS recorded 19,951 write attempts
and 9,950 ENOENT failures, versus VFS's 10,257 attempts and 256 failures. The
same engine's concurrent object writes and asynchronous native mkdir completion
can cause more native retries than synchronous VFS namespace updates. Retry and
observer scheduling are part of the experiment; these counts should not be
assumed identical in the trace-free runs or generalized to native Git CLI.
`fsCallMs` sums overlapping spans and is not CPU time or a share of wall time.

## Correctness and limits

All **70 measured backend runs** completed the workflow. Initial/changed
commit OIDs matched across pairs, pushed refs and clone HEAD were asserted,
and **448,000 cloned file-body comparisons** passed. Warmups ran the same
assertions and are excluded from these reported counts. The separate
instrumented runs verified another 98 backend runs and 450,800 file bodies.

The compatibility probes reconfirmed that an approximately 12 MiB random pack
and a 9 MiB direct write exceed inline-only capacity; the optional content tier
succeeds using MemoryOpaqueStore and verifies all six 2 MiB file bodies. That is
a capacity check, not an R2 performance benchmark. The controlled same-second,
same-size edit is still missed by isomorphic-git's stat cache even though VFS
bytes change; the timed edit changes size and is detected. The project's
1,200-line complete-replacement diff still reports its declared `E2BIG` limit.
This does not certify complete Git correctness.

Native FS uses warm OS caching; VFS SQLite is in-memory. No explicit fsync or
persistence equivalence is imposed. A persistent SQLite backend, cold-cache
work, per-file RPC, Worker memory limits, R2 network access, and the native Git
CLI require separate measurements. This report measures command elapsed time
and diagnostic calls, not peak memory or CPU usage.

## Reproduction and artifacts

```sh
npm run build
GIT_PROBE_TIMING_ONLY=1 GIT_PROBE_VARIANT=fs \
  GIT_PROBE_COUNTS=1000,10000 GIT_PROBE_WARMUPS=2 GIT_PROBE_TRIALS=7 \
  GIT_PROBE_OUTPUT=/tmp/git-timing-uncached.json node bench/git-workload.mjs
GIT_PROBE_TIMING_ONLY=1 GIT_PROBE_VARIANT=combined \
  GIT_PROBE_COUNTS=1000,10000 GIT_PROBE_WARMUPS=2 GIT_PROBE_TRIALS=7 \
  GIT_PROBE_OUTPUT=/tmp/git-timing-cached.json node bench/git-workload.mjs
GIT_PROBE_TIMING_ONLY=1 GIT_PROBE_VARIANT=combined \
  GIT_PROBE_METADATA_ENTRIES=16384 GIT_PROBE_COUNTS=10000 \
  GIT_PROBE_WARMUPS=2 GIT_PROBE_TRIALS=7 \
  GIT_PROBE_OUTPUT=/tmp/git-timing-large.json node bench/git-workload.mjs
GIT_SUMMARY_PREFIX=git-current-timing node bench/git-current-summary.mjs \
  /tmp/git-timing-uncached.json /tmp/git-timing-cached.json /tmp/git-timing-large.json
```

Run sequentially without concurrent builds or tests. Omit timing-only mode to
collect separate call/SQL diagnostics. Disabled counters in raw timing-only data
are zero placeholders; the summary marks their metrics `null`, not zero work.

- [Final summary, distributions, ratios, and raw time pairs](git-current-timing-summary.json)
- [Uncached trace-free raw data](git-current-timing-uncached-raw.json.gz)
- [Default-cached trace-free raw data](git-current-timing-cached-tiered-raw.json.gz)
- [Larger-cache trace-free raw data](git-current-timing-cached-large-raw.json.gz)
- [Instrumented diagnostics and reproduction](git-current-instrumented-comparison-2026-10-08.md)
- [Workload harness](git-workload.mjs) and [summary harness](git-current-summary.mjs)

Raw artifacts include host/tool versions, source commit/diff, settings, protocol
hash, operation outcomes, and durations. Validation: all workload/OID/body and
summary sample-count assertions passed, along with Biome, documentation links,
and performance-comparison protocol checks. No library code or defaults changed
for this benchmark task.
