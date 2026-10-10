# Instrumented Git diagnostics: native FS versus VFS — 2026-10-08

These runs enabled filesystem-call and SQL-query logging. Their times include
asymmetric instrumentation overhead and are **diagnostic measurements, not
the headline FS/VFS latency comparison**. Use the
[trace-free comparison](git-current-comparison-2026-10-08.md) for actual paired
timing results. SQL and call counts below remain useful diagnostic evidence.

The current VFS is near native FS on this complete measured Git workflow, but
individual commands differ substantially. With 1,000 files, the default metadata
cache makes repeated clean status about 35% faster than native FS; checkout and
clone remain slower. With 10,000 files, the default cache no longer provides a
clear status advantage. A 16,384-entry cache brings the status advantage back to
about 8%, while checkout and clone still lag native FS.

## Method and environment

- Same Git engine on both backends: isomorphic-git 1.43.1.
- Native backend: Node promise FS on local APFS SSD (`/System/Volumes/Data`).
- VFS backend: the current public `createFsAdapter` over NodeSqlFileSystem's
  in-memory SQLite, including the preceding string-write optimizations.
- Host: Apple M5 Max, darwin/arm64, Node v24.18.0.
- Local smart-HTTP remote: git version 2.50.1 (Apple Git-155), fresh bare repository for every run.
- Source commit: `78d7da1e6ee7d913319ec12736733a66648c623b` plus the source diff recorded in each raw
  artifact. `npm run build` completed before measurements; no library source
  changes, builds, or test suites ran during the timed comparisons.
- File counts: 100, 1,000, and 10,000, with 100 files per directory. Files contain
  approximately 0.8 KiB of deterministic text. Each backend gets a fresh repo.
- Two complete warmup pairs, then seven measured pairs for every configuration
  and count. Pair order alternates native/VFS and VFS/native.

Configurations:

1. **Uncached:** the public promise-FS adapter without optional metadata caching.
2. **Default cached/tiered:** the public adapter with a 4,096-entry
   `FsMetadataCache` and `TieredFileContent`. All committed mutations invalidate
   the cache. The measured small-text workload stays within the 8 MiB inline
   file limit; no R2 body transfer is benchmarked.
3. **Large cache:** the same optional adapter configuration with 16,384 cache
   entries, measured only at 10,000 files. This is a benchmark setting, not a
   changed library default.

Each configuration has its **own matched native control**. Native medians differ
between sessions, so absolute values across configurations should not be used as
an isolated cache A/B result. The VFS/native paired ratios are the controlled
comparison. Ratio is the median of seven per-trial ratios, not the quotient of
the two independently calculated time medians. Small effects with an interval
crossing 1 are treated as unresolved.

The 15 common timed steps populate files, add all, commit, run clean status three
times, detect one changed file, compute a one-file diff, add/commit it, create a
branch, check out the earlier commit and main, push, and clone. Diff is Git
status selection plus `readBlob` and the project's `createLineDiff`, not native
`git diff`. At 1,000 files the harness also compares individual and bulk add of
20 already tracked paths; these two extra steps are excluded from workflow totals.

This rerun corrects diff input decoding: the public adapter returns Uint8Array,
whose `toString()` produces a numeric byte list. Both backends now explicitly
decode the working bytes as UTF-8 through Buffer before line diffing. It also
ends operation timing before meter serialization. Along with the current public
adapter and library changes, these corrections mean the old probe's numbers
are historical context rather than an exact implementation A/B baseline.

Git initialization, remote creation, the one-file edit, and final whole-clone
verification are outside these totals. Operation-specific status/OID/content
assertions inside a timed step remain included on both sides. Timing is captured
before meter copying and query-summary formatting. Total **Git operations** is
the sum of the 14 common Git steps, excluding file population; it is not wall
clock time for the entire process. No filesystem caches are forcibly flushed,
and no explicit fsync/durability equivalence is imposed.

## Git-operation totals

Times are medians in milliseconds. Intervals are deterministic paired-bootstrap
95% intervals; raw pairs are retained.

| Configuration | Files | Native ms | VFS ms | Paired VFS/native | 95% interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| uncached | 100 | 164.64 | 171.85 | 1.046 | 1.029–1.092 |
| uncached | 1,000 | 611.37 | 649.45 | 1.075 | 1.047–1.083 |
| uncached | 10,000 | 6550.06 | 6718.84 | 1.021 | 1.002–1.027 |
| cached-tiered | 100 | 202.77 | 181.99 | 0.900 | 0.898–0.911 |
| cached-tiered | 1,000 | 642.76 | 601.71 | 0.951 | 0.828–0.998 |
| cached-tiered | 10,000 | 7388.51 | 7379.70 | 1.043 | 0.924–1.108 |
| cached-large | 10,000 | 7285.10 | 7323.66 | 1.023 | 0.919–1.075 |

## uncached: 1,000 files

Clean status is the third clean scan. Checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval | VFS statements | VFS returned rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| add-all | 139.08 | 155.74 | 1.125 | 1.068–1.133 | 22070 | 8040 |
| commit-one | 3.44 | 2.96 | 0.853 | 0.829–0.869 | 70 | 39 |
| status-clean-2 | 19.66 | 23.41 | 1.197 | 1.166–1.232 | 2075 | 3079 |
| diff-one-change | 20.62 | 24.17 | 1.173 | 1.086–1.191 | 2088 | 3092 |
| checkout-main | 17.57 | 33.07 | 1.886 | 1.848–1.903 | 2912 | 4912 |
| push | 178.61 | 143.21 | 0.800 | 0.795–0.808 | 2127 | 2083 |
| clone | 138.16 | 156.53 | 1.140 | 1.076–1.163 | 16494 | 8218 |

## uncached: 10,000 files

Clean status is the third clean scan. Checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval | VFS statements | VFS returned rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| add-all | 1928.06 | 1858.00 | 0.966 | 0.950–0.967 | 184616 | 71334 |
| commit-one | 23.10 | 22.71 | 0.980 | 0.899–0.994 | 160 | 132 |
| status-clean-2 | 217.75 | 225.78 | 1.043 | 1.007–1.079 | 20525 | 30532 |
| diff-one-change | 220.74 | 238.75 | 1.091 | 1.084–1.096 | 20538 | 30545 |
| checkout-main | 182.00 | 302.09 | 1.637 | 1.619–1.874 | 21470 | 41562 |
| push | 1519.46 | 1111.22 | 0.743 | 0.695–0.749 | 20487 | 20443 |
| clone | 1519.08 | 1798.98 | 1.201 | 1.184–1.217 | 161664 | 80761 |

## cached-tiered: 1,000 files

Clean status is the third clean scan. Checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval | VFS statements | VFS returned rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| add-all | 148.19 | 160.28 | 1.116 | 1.046–1.128 | 21060 | 8281 |
| commit-one | 3.58 | 3.07 | 0.819 | 0.744–1.303 | 70 | 42 |
| status-clean-2 | 19.83 | 12.86 | 0.652 | 0.593–0.685 | 62 | 1066 |
| diff-one-change | 20.69 | 13.90 | 0.684 | 0.597–0.697 | 74 | 1078 |
| checkout-main | 19.30 | 21.95 | 1.189 | 1.029–1.398 | 619 | 2619 |
| push | 187.26 | 151.12 | 0.808 | 0.763–0.837 | 2127 | 2086 |
| clone | 150.38 | 161.55 | 1.147 | 1.033–1.231 | 15487 | 8240 |

## cached-tiered: 10,000 files

Clean status is the third clean scan. Checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval | VFS statements | VFS returned rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| add-all | 2129.02 | 2179.48 | 0.981 | 0.934–1.081 | 184516 | 81491 |
| commit-one | 25.92 | 24.63 | 0.953 | 0.718–1.050 | 160 | 135 |
| status-clean-2 | 219.74 | 227.47 | 0.996 | 0.911–1.133 | 10424 | 20431 |
| diff-one-change | 244.34 | 268.72 | 1.153 | 0.979–1.208 | 10438 | 20445 |
| checkout-main | 183.24 | 352.68 | 1.931 | 1.692–2.285 | 21109 | 41201 |
| push | 1773.34 | 1277.80 | 0.777 | 0.634–0.884 | 20487 | 20446 |
| clone | 1672.30 | 2047.12 | 1.184 | 1.028–1.389 | 151747 | 80963 |

## cached-large: 10,000 files

Clean status is the third clean scan. Checkout is the earlier commit back to main.

| Operation | Native ms | VFS ms | Paired VFS/native | 95% interval | VFS statements | VFS returned rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| add-all | 2188.60 | 2138.95 | 0.975 | 0.913–1.095 | 174516 | 71491 |
| commit-one | 24.85 | 26.84 | 0.968 | 0.834–1.202 | 160 | 135 |
| status-clean-2 | 224.46 | 206.06 | 0.917 | 0.908–0.976 | 422 | 10429 |
| diff-one-change | 226.13 | 273.00 | 1.183 | 0.957–1.253 | 434 | 10441 |
| checkout-main | 186.16 | 279.98 | 1.431 | 1.226–1.655 | 10992 | 31084 |
| push | 1743.85 | 1304.47 | 0.788 | 0.690–0.808 | 20487 | 20446 |
| clone | 1716.03 | 2000.31 | 1.164 | 1.145–1.260 | 151747 | 80963 |

## Interpretation

- **No universal VFS slowdown.** At 1,000 files the uncached Git-operation sum
  is about 7.5% slower than native; with the default metadata cache it is about
  5% faster. At 10,000 files the sums are broadly near native, although the
  default-cache and large-cache intervals span both faster and slower outcomes.
  The full measured workflow including file population can favor VFS because
  in-memory string writes avoid native per-file I/O; that is why Git-only totals
  are separated from population in the raw summary.
- **Status benefits depend on scale.** At 1,000 files, default-cached clean
  status uses 62 statements rather than the uncached 2,075 and takes 12.86 ms
  versus its native control's 19.83 ms. At 10,000 files the 4,096-entry cache
  still leaves 10,424 statements. Increasing it to 16,384 lowers that to 422,
  but clean status is only about 8% faster than its native control: 206.06
  versus 224.46 ms. It still returns 10,429 SQLite rows. Fewer statements do
  not remove the full-tree listing and Git-side work. No CPU profile was taken,
  so the remaining time is not attributed to one specific JS function.
- **Checkout and clone remain the clear gaps.** At 1,000 files checkout is
  approximately 89% slower uncached and 19% slower with the default cache.
  Clone is approximately 14–15% slower in both configurations. At 10,000 files
  even the larger cache leaves checkout about 43% slower and clone about 16%
  slower. Metadata invalidation and write-heavy work remain part of these
  operations; adding cache capacity alone does not close those gaps.
- **Push favors this local VFS setup.** It is approximately 20% faster at 1,000
  files and 21–26% faster at 10,000, across the matched configurations. The
  in-memory SQL backend, native promise-FS I/O, pack work, and localhost
  transport are all part of this comparison. This does not predict production
  Durable Object RPC or R2 latency.
- **Latest string-write gains should not be overstated as Git gains.** Git
  objects and indexes generally arrive as byte buffers. The current library
  includes the new string collection improvements, but this experiment compares
  current native/VFS backends rather than isolating the immediately preceding
  library change.

## Correctness and known limits

All 98 measured repositories completed the small-text Git workflow. Initial
and changed commit OIDs matched across native/VFS pairs, pushed remote refs and
clone HEAD were verified, and **all 450,800 cloned file bodies** matched their
working-tree originals. Warmup runs performed the same assertions and are
excluded from those reported counts.

The separate compatibility probes reconfirmed:

- A roughly 12 MiB random pack and direct 9 MiB write exceed the inline-only
  adapter's 8 MiB ceiling; the optional content tier succeeds and verifies all
  six random file bodies. Its store here is `MemoryOpaqueStore`, not deployed R2.
- The controlled same-second, same-size edit remains missed by isomorphic-git's
  stat cache even though stored bytes change. The main one-file edit changes
  size, so the timed scenario explicitly detects it. This is not a complete
  Git correctness certification.
- The project's 1,200-line complete-replacement diff still raises `E2BIG` at its
  declared comparison-cell ceiling; it is not a native Git failure.

SQL counts include Node adapter BEGIN/COMMIT and returned result rows, not
Cloudflare billed rows. `fsCallMs` in raw data sums overlapping async spans and
is neither CPU time nor a fraction of wall-clock duration. Native writes use OS
caching; VFS SQLite is in-memory. Persistent SQLite, cold storage, per-file RPC,
Worker memory limits, and R2 transport need separate experiments.

## Reproduction and artifacts

```sh
npm run build
GIT_PROBE_VARIANT=fs GIT_PROBE_COUNTS=100,1000,10000 \
  GIT_PROBE_WARMUPS=2 GIT_PROBE_TRIALS=7 \
  GIT_PROBE_OUTPUT=/tmp/git-uncached.json node bench/git-workload.mjs
GIT_PROBE_VARIANT=combined GIT_PROBE_COUNTS=100,1000,10000 \
  GIT_PROBE_WARMUPS=2 GIT_PROBE_TRIALS=7 \
  GIT_PROBE_OUTPUT=/tmp/git-cached.json node bench/git-workload.mjs
GIT_PROBE_VARIANT=combined GIT_PROBE_METADATA_ENTRIES=16384 \
  GIT_PROBE_COUNTS=10000 GIT_PROBE_WARMUPS=2 GIT_PROBE_TRIALS=7 \
  GIT_PROBE_OUTPUT=/tmp/git-large-cache.json node bench/git-workload.mjs
node bench/git-current-summary.mjs /tmp/git-uncached.json /tmp/git-cached.json \
  /tmp/git-large-cache.json
```

Run sequentially without concurrent builds or tests. The first two artifacts
were captured before the harness gained the optional cache-size environment
setting; their protocol hash is identical. The third records the new setting
and protocol hash. Default behavior is unchanged by that harness addition.

- [Summary, distributions, ratios, SQL counts, and raw time pairs](git-current-summary.json)
- [Uncached full raw data, compressed](git-current-uncached-raw.json.gz)
- [Default cached/tiered full raw data, compressed](git-current-cached-tiered-raw.json.gz)
- [Large-cache full raw data, compressed](git-current-cached-large-raw.json.gz)
- [Workload harness](git-workload.mjs) and [summary harness](git-current-summary.mjs)

Validation consists of the workload/OID/full-body assertions, summary assertions
for sample counts and error-free measured steps, Biome checks, documentation
links, and the existing performance-comparison protocol checks. No library
implementation or default settings were changed for this re-evaluation.
