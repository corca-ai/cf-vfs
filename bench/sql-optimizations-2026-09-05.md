# Durable Object SQL optimizations, 2026-09-05

Four improvements were implemented and measured against the SQL implementation
at `6fa62a3`. The previously completed, uncommitted text-processing improvements
remain in the checkout; they do not participate in these direct VFS workloads.
[Raw measurements](sql-optimizations-2026-09-05.json) include medians, p10/p90,
statement counts, rows read/written, and maintenance database sizes.

## Results on local workerd

Elapsed times are milliseconds per operation. These are local measurements,
not deployed DO CPU or end-to-end latency. Counts are from real workerd SQL
cursors; transactionSync is not counted as a SQL statement. Node's tracing
adapter additionally reports BEGIN/COMMIT, so its totals are not interchangeable.

| Workload | Time before → after (ms) | SQL statements | Rows read | Rows written |
| --- | ---: | ---: | ---: | ---: |
| `batch-create-10` | 0.30 → 0.30 | 61 → 52 | 61 → 52 | 50 → 41 |
| `batch-create-100` | 2.50 → 2.20 | 601 → 502 | 601 → 502 | 500 → 401 |
| `append-string` | 0.03 → 0.03 | 7 → 6 | 7 → 7 | 3 → 3 |
| `append-bytes` | 0.03 → 0.03 | 7 → 7 | 7 → 7 | 3 → 3 |
| `find-shallow` | 12.80 → 0.10 | 7 → 2 | 20,056 → 52 | 0 → 0 |
| `find-filtered` | 10.80 → 0.80 | 7 → 2 | 20,056 → 5,051 | 0 → 0 |
| `find-all` | 11.60 → 11.00 | 7 → 7 | 20,056 → 5,061 | 0 → 0 |
| `maintenance-1000` | 0.08 → <0.01 | 1 → 1 | 2,002 → 4 | 0 → 0 |
| `maintenance-10000` | 0.81 → <0.01 | 1 → 1 | 20,002 → 4 | 0 → 0 |

Batch creation removes 99 singleton updates per 100-file transaction:
statements and reads fall 16.5%, writes 19.8%. The small latency difference is
within the observed variation and is not claimed as a speedup. String append
saves one statement (14.3%); elapsed time and billed row counts are unchanged at
this resolution. The byte-body control retains its previous SQL costs.

Shallow find avoids traversing nested directories. Filtered find avoids
materializing rejected metadata, and both use fewer statements. General find
also stops rescanning previous pages: its reads fall 74.8%, while elapsed time
is effectively unchanged because all 5,050 results still have to be returned.

Maintenance scheduling reads four rows with either 2,000 or 20,000 pending
rows. A reported zero median is below the 0.01 ms amortized sampling quantum,
not zero CPU cost; raw p90 is retained rather than claiming a 100% speedup.

## Implementations and tradeoffs

### Batch usage

The write batch retains a running usage total for quota checks and flushes the
aggregate inside the same transaction. Intermediate parent-directory creations
participate in the same total. Usage events publish after commit; failed
batches discard both cached totals and pending events. Entry identities still
persist their allocation high-water mark in that usage write.

This also fixes an existing quota defect confirmed against the baseline:
with maxEntries=4, two files under newly created `/a/b` previously committed
five total entries. The final check now includes parents and rolls the entire
batch back. Net-zero replacement batches remain allowed.

### String append

Strings collect synchronously and reuse the preflight row. A conditional
UPDATE checks the captured mutation version before chunks are written, so a
synchronous host callback cannot turn the shortcut into a stale append.
Stream/byte bodies retain post-collection revalidation. Empty appends still
revalidate and do not mutate the file. The conditional UPDATE costs a result
row, which is why saving one statement does not also reduce rows read.

### Find and pagination

The indexed range begins at SQL `MAX(rangeLower, cursor)`, retaining SQLite's
text ordering even where UTF-16 JavaScript ordering differs. Public findPage
keeps exactly the same scanned-row limits, returned entries, and cursors.

Materializing find can use the parent/name index for maxDepth=1 and skip
descendants for shallower limits. Type and literal-name-prefix predicates can
filter candidates in SQL before metadata parsing. The prefix predicate is a
superset; the existing JavaScript glob matcher still decides acceptance.
Only a literal prefix plus one trailing star reaches SQLite GLOB, and only
within Durable Object SQLite's 50-byte UTF-8 pattern limit. Longer prefixes
retain JavaScript filtering. Multiple
wildcards, bracket expressions, escapes, and trailing-newline semantics are
not delegated to a potentially backtracking SQL pattern. Permission checks
still run with the original traversal policy before these shortcuts.

### Maintenance and schema version 8

Each scheduling category queries its own minimum. An expression index covers
MAX(not_before_ms, next_attempt_at_ms), and a partial index covers verification
lease expiry. The verification query names that index explicitly because the
initial experiment otherwise chose the state/expiry index and still scanned
all verifying sessions. Open and committed sessions use the existing index.
Earlier host alarms are preserved; empty maintenance queues do not delete them.

There is a measured write/space cost: one GC queue insertion changes from
**2 to 3 rows written**. At 10,000 GC entries plus 10,000 upload sessions, the
measured database grows from **2,031,616 to 2,338,816 bytes** (+307,200 bytes,
15.1%). At 1,000 entries per table, the increase is 36,864 bytes. The partial
verification index also adds maintenance work while a session is verifying.
These indexes are most valuable when pending queues are large or scheduling
is frequent; they do not reduce R2 operations. Small inline operations incur
no extra SQL query or row write from these indexes. Their empty index pages
still add 8 KiB to the measured inline benchmark database, even without GC
entries; the 15.1% increase above applies to the maintenance-heavy fixture.

## Method and validation

Apple M5 Max, Darwin 25.5.0 arm64; Node 26.8.1, workerd 1.20260714.1,
Wrangler 4.114.0, Workers Vitest pool 0.18.6. No deployment was performed.
Measurements ran sequentially in isolated baseline/current checkouts with
identical dependencies, three warm-ups, and eleven samples. Each sample
averages ten operations, or 100 for append/maintenance. An earlier reverse
A/B round reproduced the structural costs. Other tests/builds did not run
concurrently with timing measurements.

Batch cases create 10 or 100 fresh one-byte files each iteration. Appends add
one byte to an initially 8 KiB body. Find scans a tree containing 50 directories
and 5,000 files, with 50 target-prefixed names. Each maintenance case seeds the
stated count in each of two tables; the three active session states are mixed.
Setup is outside measurement; result validation is identical in both builds.

`bench/sql-differential.mjs` compares **31,104** find/findPage results against
the saved baseline, including complete metadata, cursors, scanned counts,
Unicode paths, newlines, depths, limits, types, and glob patterns. Regression
tests cover deferred usage/events, rollback, parent quotas, synchronous append
races, populated schema migration, and shared alarm ownership. An external
watchdog covers hostile SQL-prefilter candidates as well as regex budgets.

`npm run check` passed: 1,693 Node tests, 107 workerd tests, 14 isolated-process
execution checks, type/lint/unused-code/complexity checks, documentation and
package checks, and all nine bundle budgets. `npm run bench:check` passed
17 Node scenarios and 27 workerd benchmark tests. Existing point-read,
overwrite, subtree-operation, and byte-append structural costs are unchanged.

Relative to the preceding text-processing changes, this SQL pass adds 3,041
bundle bytes to the VFS, R2, and Linux presets. The resulting sizes are
182,775 / 184,146 / 674,286 bytes, within the existing
188,032 / 189,568 / 700,544-byte budgets. The minimal shell, default registry,
AWK, interactive, and small applet presets are unchanged by this SQL pass.

## Reproduction

```sh
npm run bench:check
npx vitest run --config vitest.performance.config.ts --disableConsoleIntercept bench/sql-optimization.bench.ts
npm run build
node bench/sql-differential.mjs /path/to/saved/baseline/dist
```

For a historical A/B run, copy the benchmark harness into an isolated checkout
of `6fa62a3` with identical dependencies. Omit only the final expectedCosts
assertion when running the old implementation; those assertions encode the
new lower SQL costs and run outside the timed samples. Keep all result
assertions and workload parameters identical.
