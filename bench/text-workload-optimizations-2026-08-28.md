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

## Token schema candidate (adopted after production validation below)

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

This first result was a schema spike rather than production evidence. The later
round below adds the migration and exercises the real filesystem operations.

## Follow-up: allocation, decoding, and one-chunk writes

The follow-up baseline is `9b45f3a`. Each JavaScript result below is the median
of seven runs in one process, comparing the candidate immediately before and
after its isolated change. The workload uses one 8 KiB UTF-8 body; collector
tests run 20,000 operations, text decoding runs 10,000 operations, and the pipe
test transfers 1,000 chunks. The workerd storage point runs the same guarded
8 KiB overwrite and read/edit sequence as the durable-object benchmark.

| Area | Before | After | Result |
| --- | ---: | ---: | ---: |
| synchronous string collection | 97.627 ms | 86.379 ms | −11.5% |
| digest-capable string collection | 157.535 ms | 87.077 ms | −44.7% |
| bounded UTF-8 text collection | 36.889 ms | 30.363 ms | −17.7% |
| 1,000 pipeline writes | 3.750 ms | 2.670 ms | −28.8% |
| pipeline `slice()` calls | 2,000 | 1,000 | −50.0% |
| pipeline bytes copied by `slice()` | 16.384 MB | 8.192 MB | −50.0% |
| one-chunk overwrite rows read | 9 | 7 | −22.2% |
| read/edit rows read | 12 | 10 | −16.7% |
| one-chunk overwrite CPU | 0.030 ms | 0.025 ms | −16.7% |

A materialized body that already fits one storage chunk no longer allocates a
256 KiB slab and then slices the used prefix. For an 8 KiB string, the
digest-capable collector's byte-array allocation falls from about 272 KiB
(encoding, slab, and result) to 8 KiB. Caller-owned arrays and views still take
one snapshot; only the private `TextEncoder` result is transferred directly.

An existing inline entry now uses a narrow `UPDATE` instead of the generic
entry upsert, and an existing one-chunk body uses a narrow chunk `UPDATE`.
Workerd retained four statements and three rows written while reducing rows
read. Seven post-change point runs all reported exactly 7 overwrite rows and
10 read/edit rows; the overwrite CPU samples had a 0.025 ms median.

`collectText` now decodes each stream chunk directly with a fatal streaming
decoder. This removes the byte-chunk snapshots, contiguous byte-array assembly,
and final whole-array decode. The retained lease still charges the total input
bytes until the command releases the text; eliminating the transient second
lease means a 1,800-byte two-file command now fits a 2,000-byte budget, while a
1,700-byte budget still rejects it.

Finally, `ShellSink` remains the single ownership boundary for pipeline and
redirection writes. Its snapshot is now passed through instead of being copied
a second time by each downstream sink. Tests mutate the caller's array before
the write promise settles and verify that both pipeline and atomic-redirection
outputs retain the bytes accepted at the call boundary.

The focused VFS preset grew from 157,576 to 159,070 deployed bytes (+1,494,
+0.95%), and the R2 preset grew by the same 1,494 bytes. The one-applet shell
preset shrank by 16 bytes; the complete default command registry grew from
453,786 to 454,961 bytes (+1,175, +0.26%). The Linux profile, which contains
both the filesystem and full shell, grew from 605,166 to 607,835 bytes (+2,669,
+0.44%). Every preset remains within its recorded tree-shaking budget.

## Next round: redirection, fused reads, and live-token placement

An atomic redirection whose output arrived in zero or one sink write now hands
that already-owned array directly to the VFS instead of wrapping it in a new
`ReadableStream`. Across seven runs of 500 complete 8 KiB `cat > file`
executions, this removed exactly 500 allocations of the 256 KiB collection
slab. Three interleaved before/after process groups, each itself the median of
seven 500-operation runs, moved from 64.802 to 63.266 ms (−2.4%); parsing and
SQLite dominate the full command. An isolated alternating-order collector
benchmark exposed the affected work more directly: 20,000 one-chunk stream
collections took 200.352 ms versus 22.537 ms for the materialized handoff
(−88.8%). The retained change therefore removes 128 MiB of transient
allocation per 500 small redirections while providing a small end-to-end gain.
It adds 83 deployed bytes to shell-containing presets and nothing to the VFS-only
or R2 presets.

A fused one-chunk read was rejected. Joining metadata, path version, and the
first BLOB reduced a small read from two statements to one, but workerd rows
read did not move and 10,000 Node reads regressed from 323.008 to 363.814 ms
(+12.6%). The implementation was removed: fewer statements are not useful when
the combined query performs the same storage work more slowly.

The separated live-token schema was then repeated against actual workerd
SQLite rather than only Node's `DatabaseSync`. Each layout held 10,000 live
8 KiB metadata rows; measurements are medians of five runs.

| Metric | split path-version table | live token on entry | Result |
| --- | ---: | ---: | ---: |
| database bytes | 1,613,824 | 1,306,624 | −19.0% |
| 10,000 point stats | 32 ms / 20,000 rows | 29 ms / 10,000 rows | −9.4% / −50% |
| 500 listing pages | 40 ms / 100,000 rows | 35 ms / 50,000 rows | −12.5% / −50% |
| 5,000 token updates | 23 ms / 10,000 statements | 16 ms / 5,000 statements | −30.4% / −50% |
| update rows read / written | 15,000 / 10,000 | 10,000 / 5,000 | −33.3% / −50% |

The candidate keeps removed-path versions in a tombstone table and keeps the
change feed in a separate table, so a workspace with recording disabled does
not pay a live-row index cost for that feature. These results justified the
production validation below.

## Production adoption: colocated live mutation versions

Schema migration 7 moves each live version onto `vfs_entries`, copies absent
versions into `vfs_path_tombstones`, copies non-zero cursor state into
`vfs_path_changes`, and then drops the combined table. New and upgraded
databases both execute the same migration, so their final schema descriptions
remain identical. A live path and a tombstone are mutually exclusive after
every transaction.

The mutation version now rides the entry statement that already changes
content or metadata. Remove transfers `version + 1` to a tombstone; recreate
consumes it. Recursive copy and move derive every destination version from that
destination path's history, while source removals retain their own history.
This is path-token behavior, not inode-token behavior, and matches the previous
API semantics.

Actual workerd storage counters changed as follows:

| Production workload | Before | After | Result |
| --- | ---: | ---: | ---: |
| populated point stat | 1 statement / 2 rows read | 1 / 1 | rows −50.0% |
| guarded one-chunk overwrite | 4 statements / 7 read / 3 written | 3 / 5 / 2 | statements −25.0%, read −28.6%, written −33.3% |
| 8 KiB read then guarded edit | 6 statements / 10 read / 3 written | 5 / 7 / 2 | statements −16.7%, read −30.0%, written −33.3% |
| create 512 files of 8–12 KiB | 3,584 statements / 3,584 read / 3,072 written | 3,584 / 3,584 / 2,560 | written −16.7% |
| randomly read those 512 files | 1,024 statements / 2,047 rows | 1,024 / 1,535 | rows −25.0% |
| move 2-entry subtree | 8 statements / 95 rows read | 8 / 66 | rows −30.5% |
| move 25-entry subtree | 8 statements / 164 rows read | 8 / 112 | rows −31.7% |

Across five workerd process runs, structural point counts were identical. The
median 200-operation overwrite sample was 0.025 ms, equal to the immediately
preceding production median; removing storage work did not produce a stable
clock-level improvement at that size. The 10,000-row isolated workerd A/B
remained stable at 1,306,624 versus 1,613,824 bytes (−19.0%), half the stat and
listing rows, and half the token-update statements.

The cursor stays opt-in and physically independent. In a production mixed run
of overwrite, metadata, recursive copy, move, and remove, cursor-off used 31
statements / 348 rows read / 111 rows written and left zero change rows.
Cursor-on used 37 / 436 / 195 and retained 31 latest-path changes. For the most
frequent point overwrite specifically, off cost 3 / 5 / 2; on cost 4 / 5 / 4.
The extra change-table/index writes are therefore explicit and confined to the
feature that requested them rather than charged to every workspace.

Validation covers migration from versions 1, 2, and a seeded version 6 with a
live token, an absent tombstone, and unread cursor changes. Behavioral tests
exercise create/delete/recreate monotonicity, unrelated descendant tombstone
retention, symlink replacement and link-chain ABA, recursive copy/move/remove,
page boundaries through set mutations, and rollback silence. The complete Node
suite (1,392 tests), Durable Object conformance suite (97 tests), and workerd
performance suite (10 tests) pass.

The migration and set-mutation SQL add 5,147 deployed bytes to filesystem
presets: VFS is 164,217 bytes and R2 is 166,828 bytes. The shell-only preset is
unchanged by this schema work; the Linux profile is 613,065 bytes. All eight
tree-shaking presets remain inside their recorded budgets. The roughly 3.2%
VFS bundle increase is the principal retained cost of removing the permanent
second namespace index and its per-operation storage work.

## Follow-up: conditional reuse of a read snapshot

After the live token moved onto the entry, a direct inline read already held
all metadata needed to plan a guarded small-text replacement. The filesystem
now retains only that one `EntryRow` as a hint — never its body — and folds
validation into the publishing `UPDATE ... WHERE mutation_version = ?`. A
concurrent mutation makes the UPDATE return no row; the ordinary lookup path is
then rerun so the existing disposition, permission, and guard error precedence
is preserved.

The fast path is intentionally narrow: a materialized string body, an explicit
matching mutation token, a direct non-directory path, no `create` disposition,
and no credential-bound view. Symlink chains, streamed/caller-controlled
bodies, create semantics, and POSIX credential checks continue through the
ordinary preflight. This removes a successful lookup without trusting cached
state across an `await` or across two filesystem wrappers over one database.

On actual workerd, an 8 KiB read followed by a guarded edit moved from 5
statements / 7 rows read / 2 rows written to 4 / 6 / 2 (−20.0% statements,
−14.3% reads). An isolated write-after-read comparison ran five interleaved
1,000-operation cached/uncached groups per process. Across three processes, the
median process result was 0.017 ms cached versus 0.023 ms uncached (−26.1%);
structural counts remained the primary evidence because individual samples are
near the workerd clock resolution. `sed -i` correspondingly falls from 7 to 6
local SQL statements.

Tests hold a snapshot in one filesystem wrapper, mutate or remove the file
through a second wrapper over the same SQLite database, and verify `EREVISION`
or the existing `ENOENT` precedence with the concurrent body left intact. A
trailing-slash assertion also proves the hint cannot bypass pathname semantics.
The metadata hint adds 1,111 deployed bytes and one bounded `EntryRow` per
instance: VFS is 165,328 bytes, R2 is 167,939 bytes, and Linux is 614,176 bytes.
All bundle budgets pass; the Node suite now contains 1,393 tests.

## Follow-up: transfer the SQL-owned inline snapshot once

The inline read path wrapped every returned BLOB in a `Uint8Array` and then
called `slice()`, even though both supported storage adapters had already
created an independently owned result buffer. The Node adapter snapshots
`node:sqlite`'s `Uint8Array` before exposing it. Workerd's SQL implementation
copies each SQLite BLOB into a `kj::Array<byte>`, then moves that allocation into
the JavaScript `ArrayBuffer`; its own source explicitly describes the ownership
transfer as avoiding another copy. See the Cloudflare
[`SqlStorage` implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.c%2B%2B)
and [declaration](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.h).

Removing the library-level `slice()` eliminates exactly one allocation and one
body-sized memcpy for every stored inline chunk read. In the representative
workerd run, randomly reading 512 files of 8–12 KiB therefore avoids copying
5,242,790 bytes. Three isolated process runs had read times of 24, 21, and 25 ms
before, versus 23, 19, and 42 ms after; medians are 24 and 23 ms (−4.2%). The
42 ms candidate outlier makes elapsed time supporting rather than primary
evidence. Node's seven-group 5,000-read median for an 8 KiB file moved from
101.277 to 100.002 ms (−1.3%). SQL statements and rows are unchanged.

The returned byte stream still owns and transfers each chunk. New Node and
actual-workerd tests mutate a delivered chunk, cancel the stream, and re-read
the file to prove that the database remains unchanged. The existing active
reader tests additionally overwrite the file before consuming its old stream,
covering snapshot stability across a mutation. The complete check passes with
1,394 Node tests and 98 Durable Object tests. Removing the call reduces each
filesystem preset by 8 deployed bytes: VFS is 165,320 bytes, R2 is 167,931
bytes, and Linux is 614,168 bytes.

A nearby allocation idea, reusing one module-level `TextEncoder`, was rejected.
For 100,000 encodes of an 8 KiB string across seven interleaved groups, fresh
and shared encoders had effectively identical medians (423.68 and 423.57 ms).
It would retain global mutable-looking state without a demonstrated benefit, so
no production code was changed for that candidate.

## Follow-up: decode the public UTF-8 reader in one pass

The public `readUtf8()` helper still routed its stream through `readAllBytes()`.
For one 8 KiB VFS chunk this first snapshotted the delivered bytes, then copied
them into a contiguous output array, and only then decoded the second array.
The replacement feeds a fatal `TextDecoder` directly as chunks arrive and
joins decoded strings. It retains the byte-based maximum, `EFBIG` wording,
path-bearing `EIO` for malformed UTF-8, reader cancellation on failure, and
correct decoding when a multi-byte scalar crosses chunk boundaries.

Each one-chunk call removes two body-sized byte allocations and copies: 16 KiB
for the representative 8 KiB file, or 81.92 MB across 5,000 reads. In seven
Node groups of 5,000 SQLite-backed reads, the median moved from 115.270 to
105.529 ms (−8.5%). The production workerd point benchmark now includes 5,000
bounded UTF-8 reads. Three isolated process averages were 0.0254, 0.0244, and
0.0252 ms before versus 0.0236, 0.0322, and 0.0238 ms after; the process medians
are 0.0252 and 0.0238 ms (−5.6%). The candidate outlier again makes eliminated
allocation the primary evidence and elapsed time supporting evidence.

Tests cover a four-byte result whose euro sign is split across two stream
chunks, an incomplete terminal sequence, and a source that records its
cancellation when the byte limit is exceeded. This is an internal execution
change to an existing API; callers neither opt in nor change how they consume
the returned string. Tree shaking removes the helper from presets that do not
use it, so all eight deployed bundle measurements are unchanged.

## Follow-up: return the one-chunk byte snapshot directly

`collectBytes()` snapshots every delivered chunk before retaining it, but
`readAllBytes()` then always allocated a contiguous result and copied those
snapshots into it. When exactly one non-empty chunk was collected, returning
that already-private snapshot preserves caller ownership and removes the final
body-sized allocation and copy. Empty and multi-chunk streams keep the previous
assembly path. A regression test mutates the returned array and verifies the
producer's source array is unchanged.

An isolated 10,000-operation, 8 KiB byte-stream collection moved from a
29.386 ms seven-group median to 24.642 ms (−16.1%) while eliminating 81.92 MB
of output copies. End-to-end storage timings did not resolve that small local
gain: the seven-group Node SQLite median was 107.020 ms before and 108.915 ms
after, while three-process workerd medians for 512 random 8–12 KiB reads were
23 ms on both sides. The retained claim is therefore lower transient
allocation and GC pressure with no demonstrated storage-level latency change,
not a throughput increase. The branch adds 109 deployed bytes to presets that
retain `readAllBytes()` through the shell: shell is 227,182 bytes, interactive
is 236,831, the default registry is 455,153, and Linux is 614,277. VFS-only and
R2 presets remain unchanged. All bundle budgets, 1,397 Node tests, 98 Durable
Object tests, and 10 workerd benchmark tests pass.
