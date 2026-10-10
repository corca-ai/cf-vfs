# Extension API removal evaluation — 2026-10-08

The recent POSIX improvements do not justify removing any of the reviewed
public extensions. Aggregation, cached digest lookup, large-file ranges, and
bounded directory pages still avoid substantial work. Batch writes and
unchanged-write suppression have weaker latency arguments on small workloads,
but preserve atomicity and publication semantics that ordinary calls cannot.

## Method

Library source: `78d7da1e6ee7d913319ec12736733a66648c623b` (clean source tree).
Runtime: v24.18.0, darwin/arm64, Apple M5 Max.

Build with `npm run build`, then run
`node bench/extension-api-evaluation.mjs`. The script writes
[raw samples and summaries](extension-api-results.json).
It runs three warmup pairs and seven measured pairs per workload, alternates
variant order, and records SQL statements and returned rows alongside elapsed
time. The final recorded run had no concurrent test or build process. Earlier
exploratory runs supported the same keep/remove decisions.

The table reports **milliseconds per operation**, dividing each sample group's
median by its repetition count. Queries, stream consumption, and result
assertions are included. Namespace setup and file creation are outside the
measured region. Files use the current default 256 KiB chunk size; tree files
are four bytes each. Digest results are warmed explicitly. Partial reads select
the last 16 bytes; the whole-read baseline consumes the whole snapshot rather
than timing creation of an unread stream. That comparison is appropriate to a
whole-file fallback, not a claim about every possible early-cancel reader.

## Current implementation versus replacements

| Workload | Size / count | Extension ms/op | Replacement ms/op | Replacement / extension | Extension statements / returned rows | Replacement statements / returned rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| subtree-summary (`aggregate` / `paged-walk`) | 100 | 0.0169 | 0.3088 | 18.25× | 2 / 2 | 2 / 101 |
| list-page-first (`listPage` / `list-slice`) | 100 | 0.2953 | 0.2797 | 0.95× | 2 / 101 | 2 / 101 |
| find-page-first (`findPage` / `find-limit`) | 100 | 0.2936 | 0.2910 | 0.99× | 2 / 101 | 2 / 101 |
| subtree-summary (`aggregate` / `paged-walk`) | 10,000 | 0.8098 | 28.5519 | 35.26× | 2 / 2 | 22 / 10021 |
| list-page-first (`listPage` / `list-slice`) | 10,000 | 0.2916 | 29.6427 | 101.67× | 2 / 102 | 2 / 10001 |
| find-page-first (`findPage` / `find-limit`) | 10,000 | 0.2982 | 0.2986 | 1.00× | 2 / 102 | 2 / 102 |
| subtree-summary (`aggregate` / `paged-walk`) | 20,000 | 1.8608 | 58.4052 | 31.39× | 2 / 2 | 42 / 20041 |
| list-page-first (`listPage` / `list-slice`) | 20,000 | 0.3081 | 59.7404 | 193.89× | 2 / 102 | 2 / 20001 |
| find-page-first (`findPage` / `find-limit`) | 20,000 | 0.2973 | 0.2949 | 0.99× | 2 / 102 | 2 / 102 |
| digest-warm (`cached` / `read-hash`) | 8,192 | 0.0067 | 0.0298 | 4.42× | 1 / 1 | 2 / 2 |
| range (`ranged` / `whole-read`) | 8,192 | 0.0121 | 0.0110 | 0.91× | 2 / 2 | 2 / 2 |
| range-vs-descriptor (`ranged` / `open-read-close`) | 8,192 | 0.0122 | 0.8046 | 65.78× | 2 / 2 | 8 / 5 |
| unchanged-write (`skip` / `overwrite`) | 8,192 | 0.0311 | 0.0197 | 0.63× | 5 / 3 | 5 / 3 |
| digest-warm (`cached` / `read-hash`) | 8,388,608 | 0.0063 | 3.8134 | 600.73× | 1 / 1 | 2 / 33 |
| range (`ranged` / `whole-read`) | 8,388,608 | 0.0552 | 0.9754 | 17.66× | 2 / 2 | 2 / 33 |
| range-vs-descriptor (`ranged` / `open-read-close`) | 8,388,608 | 0.0540 | 0.8730 | 16.17× | 2 / 2 | 8 / 5 |
| unchanged-write (`skip` / `overwrite`) | 8,388,608 | 6.8961 | 13.5264 | 1.96× | 5 / 3 | 5 / 2 |
| batch-overwrite (`batch` / `individual`) | 1 | 0.0719 | 0.0598 | 0.83× | 7 / 5 | 5 / 3 |
| batch-overwrite (`batch` / `individual`) | 3 | 0.2132 | 0.1998 | 0.94× | 15 / 13 | 15 / 9 |
| batch-overwrite (`batch` / `individual`) | 100 | 6.4412 | 6.1646 | 0.96× | 403 / 401 | 500 / 300 |

## Removal decisions

No public API was removed. The current implementation still has either a
material performance benefit or a contract that the proposed replacement
cannot preserve.

- **`subtreeSummary`: retain.** The alternative uses a complete paged traversal,
  not `find()` with its default 10,000-result ceiling. The measured aggregate
  returns two SQL rows irrespective of tree size; the walk returns one stat per
  entry plus page overhead. Both must inspect the subtree in SQLite; the
  aggregate does not make that work O(1), but avoids materializing it in JS.
- **`digestFile`: retain.** Repeated inline hashes still avoid body transfer and
  hashing. It shares the revision-stamped cache with `skipIfUnchanged`, so
  removing this method would not remove that cache while the latter remains.
  Opaque files also need a way to obtain verified digests without downloading
  their bodies into the metadata DO.
- **`readFile({ range })`: retain.** A small one-chunk file has no meaningful
  latency benefit here. Large files still return two SQL rows rather than 33,
  and materialize only selected chunks. The new descriptor API does not erase
  this benefit: opening, reading, and closing for a single operation performs
  eight statements versus two for a range. This comparison includes descriptor
  setup and teardown; it is not a claim about workloads reusing one open handle.
  Handles also have live inode semantics, while VFS reads provide snapshots.
- **`listPage`: retain.** Small directories tie full listing, but large
  directories return approximately the requested page size rather than all
  entries. Substituting `findPage({ maxDepth: 1 })` is not equivalent: its
  bounded scan traverses descendants before filtering depth, and its
  credential preflight checks subtree permissions rather than only listing
  permissions on this directory.
- **`findPage`: retain.** `find({ limit: 100 })` ties the first unfiltered page,
  so this is not an additional speed win on that workload. It does not return
  `nextCursor` or `scanned`. An empty filtered page can still require
  continuation; the benchmark verifies this case. Full `find()` materializes
  results and defaults to a 10,000-result ceiling. `findPage` remains the
  bounded traversal contract used by recursive command input expansion.
- **`writeFiles`: retain for atomicity, not a blanket speed claim.** On current
  same-size overwrites, one and three entries do not save statements, and 100
  entries save statements but return more rows. Latency alone does not justify
  the API here. Separate writes cannot preserve all-or-nothing publication,
  per-entry guards, or quota checks against the final set. Existing batch
  conformance tests cover rollback and stale guards.
- **`skipIfUnchanged`: retain for avoiding publication.** An 8 KiB ordinary
  overwrite is faster in this workload, so the option is not a small-file
  latency optimization. It avoids changing revision, timestamp, token, and
  notifications when the snapshot is unchanged. The large-body case still
  avoids rewriting stored chunks. The two variants share a path and alternate:
  an overwrite invalidates the cached digest, so skip samples can include a
  cold first call; the raw data records each sample's resulting SQL cost.
- **Recursive `copy`, `move`, `remove`: retain.** These back standard commands,
  preserve transactional namespace changes, and support opaque metadata-only
  operations. Replacing them with read/write/unlink loops would change failure,
  identity, and R2 transfer behavior. They were reviewed for contract necessity,
  not assigned a fabricated timing comparison with non-equivalent loops.
- **Mutation tokens and guards: retain.** They detect races, including changes
  in traversed paths, and are used by collaboration and the optional content
  tier. `stat` can carry an existing entry's token but cannot replace token
  lookup for an absent write destination.
- **`statById`: retain for identity lookup.** A path stat cannot follow an entry
  through a rename when the caller only retains its identity. The current
  performance guard confirms one statement and one returned row; this is not
  a standard-tool speed extension.
- **`changesSince`: retain for catch-up.** A live event listener cannot report
  mutations missed while disconnected. Recording is opt-in and the off-path
  cost is guarded. Removal would remove supported synchronization behavior.
- **Opaque upload, read leases, and GC: retain for R2 lifecycle.** They publish
  verified immutable bodies and keep generations available while readers hold
  leases. No improvement to inline POSIX paths substitutes for those contracts.

## Validation and limits

Commands executed:

```sh
npm run build
node bench/extension-api-evaluation.mjs
npx vitest run --config vitest.node.config.ts \
  test/performance-sql-read.test.ts \
  test/performance-sql-write.test.ts \
  test/performance-sql-shell.test.ts
npx vitest run --config vitest.performance.config.ts \
  bench/posix-handles.bench.ts bench/sql-optimization.bench.ts \
  --disableConsoleIntercept
npm test
npx biome check bench/extension-api-evaluation.mjs
npm run test:docs
```

The focused Node cost tests passed (28 tests). The local workerd checks passed
(8 tests), including descriptor reads whose SQL cost stays independent of full
file size: three statements, four billed rows read, and no writes on a reused
handle for both 32 KiB and 8 MiB. Node VFS returned-row counts are not workerd
billed-row counts and must not be compared directly. The complete ordinary test
run passed 1,821 Node tests and 125 workerd tests.

Latency comparisons in the table are Node in-memory SQLite measurements, not
new deployed Cloudflare A/B measurements. SQL row counts give evidence of
avoided materialization; they do not directly measure peak memory or bundle
size. Small timing differences are treated as ties or workload-specific costs,
not grounds to remove a public capability. No source changes or public-contract
breaks were made as part of this audit.
