# Small-text workload optimizations — 2026-08-28

Target workload: repeatedly read and edit code or Markdown files below 10 KiB,
while preserving POSIX behavior and the existing public API. The before revision
is `370a17d`. Measurements ran on an Apple M4 with macOS 26.5.1 and Node
v24.18.0; workerd storage counts used `@cloudflare/vitest-pool-workers` 0.18.6.
Elapsed values are medians and are supporting evidence. Exact SQL statements,
rows, conformance tests, and round-trip tests are the regression signals.

## Retained changes

| Area | Before | After | Result |
| --- | ---: | ---: | ---: |
| localized diff, 999 lines / 3.9 KiB | 4.629 ms | 0.0375 ms | −99.2% |
| localized diff, 1,000 lines | `E2BIG` | 0.0374 ms | now succeeds |
| 20,000-child first listing page | 6.306 ms | 2.881 ms | −54.3% |
| 20,000-child late listing page | 3.806 ms | 2.818 ms | −26.0% |
| materialized `find`, 10,000 entries | 20 statements | 11 statements | −45.0% |
| credential `find`, 1,006 entries | 7 statements | 5 statements | −28.6% |
| same-size `sed -i` | 12 statements | 8 statements | −33.3% |
| shrinking existing-file redirection | 13 statements | 9 statements | −30.8% |
| private 8 KiB chunk stream, 10,000 reads | 36.923 ms | 32.397 ms | −12.3% |

The diff now removes an unchanged prefix and suffix before allocating the LCS
matrix. An all-different 1,000 by 1,000 comparison still returns `E2BIG`; the
bound was made workload-sensitive, not removed. Patch round-tripping verifies
line-number reconstruction across the trimmed ranges.

`listPage()` now starts the `(parent_path, name)` range at the direct-child
cursor while retaining the path predicate for arbitrary cursors. A cursor that
names a descendant rather than a returned child retains its previous result.
Materialized `find()` resolves the root, checks credentials, computes the path
range, and compiles globs once for all pages.

`sed -i`, `patch`, and atomic redirection reuse a stat and mutation token they
already obtained. A symlink whose returned canonical path differs from its
named path deliberately falls back to the full guard-token lookup, preserving
the link-chain ABA check. Inline reads transfer SQLite-owned byte arrays into
the returned stream; the public `streamFromChunks()` continues cloning
caller-owned arrays.

The workerd point guard additionally records a complete 8 KiB read followed by
a guarded same-size write at 6 statements, 12 rows read, and 3 rows written.

The measured VFS preset moved from 157,063 to 157,576 bytes (+513, +0.33%) and
the R2 preset from 159,674 to 160,187 bytes (+513, +0.32%). Of that, the private
owned-chunk stream accounts for 165 bytes. The standard bundle recorder reset
all preset ceilings to five-percent headroom from their measured output; the
budget jump is headroom, not an equivalent deployed-size increase. Source-map
reachability and exclusion checks remain unchanged.

## Rejected one-entry body cache

A 64 KiB one-entry MRU cache reduced a 5,000-cycle 8 KiB read/edit loop from
40,000 to 35,000 local SQL calls (−12.5%), but elapsed time moved only from
519.65 ms to 506.17 ms (−2.6%). It added about 1,053 deployed bytes and up to
64 KiB per filesystem instance. Workerd reduced the read/edit cost by only one
statement and one row read. The cache was removed: the lifetime and bundle
cost do not justify the small result.

## Rejected inline BLOB in the entry row

`node bench/schema-layout-spike.mjs` compares production-shaped SQLite layouts
over seven repetitions. The inline-body workload stores 512 files from 8 to
12 KiB, then performs 10,240 reads, 5,000 same-size overwrites, 5,000 metadata
updates, and 1,000 full metadata scans.

| Entry-row threshold | DB bytes | Read | Overwrite | Metadata update | Metadata scan |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 (chunk table) | 6,144,000 | 53.519 ms | 26.882 ms | 3.015 ms | 138.862 ms |
| 4 KiB | 6,144,000 | 53.312 ms | 27.091 ms | 3.054 ms | 138.105 ms |
| 16 KiB | 5,685,248 | 20.986 ms | 8.931 ms | 6.970 ms | 159.040 ms |

Embedding these files improves reads by 60.8%, overwrites by 66.8%, and
database bytes by 7.5%, but makes metadata-only updates 131.2% slower and scans
14.5% slower because every namespace row becomes BLOB-wide. That changes the
performance semantics of `chmod`, `chown`, `stat`-oriented scans, and directory
work in the wrong direction, so this layout is not retained.

## Promising but deferred token schema

The same script models 100,000 live files, 100,000 point operations, 2,000
100-entry listing pages, 2,000 change-feed pages, 20,000 feed-enabled updates,
10,000 delete/recreate cycles, and seven alternating-order repetitions.

Putting both live and removed paths into separate indexes made the feed merge
two ordered sources and was rejected. Separating the three concerns instead —
live tokens on entries, removed-path tombstones, and a change table populated
only when recording is enabled — produced:

| Metric | Current split table | Separated design | Change |
| --- | ---: | ---: | ---: |
| database bytes | 17,391,616 | 15,753,216 | −9.4% |
| point stat | 167.056 ms | 129.270 ms | −22.6% |
| listing pages | 87.115 ms | 60.180 ms | −30.9% |
| change-feed pages | 361.187 ms | 61.081 ms | −83.1% |
| token updates, feed off | 321.434 ms | 234.230 ms | −27.1% |
| token updates, feed on | 77.908 ms | 66.558 ms | −14.6% |
| delete and recreate | 66.655 ms | 52.420 ms | −21.4% |

This is a schema spike, not production evidence. Adopting it requires a new
migration and must prove token monotonicity for creation, deletion, recursive
copy/move/remove, symlink guards, and change-sequence groups on real workerd
storage. It is kept as the next high-value candidate rather than being mixed
into the low-risk changes without those proofs.
