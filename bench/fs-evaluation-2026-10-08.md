# Independent filesystem experiments — 2026-10-08

Baseline: `edef5918735e54df5c46e6a5ea5bbfc43b0ff2a2`.

These experiments improve general filesystem behavior, without special cases for
Git paths or objects. All measurements are local. Git uses isomorphic-git 1.43.1
on Node v24.18.0; push/clone use a fresh localhost smart-HTTP native Git remote.
Node timings are not Cloudflare production latency or memory measurements.

## Decisions

| Experiment | Decision | Evidence |
| --- | --- | --- |
| 1. Reuse listed metadata | Keep, optional | Independent 1,000-file clean status: 35.34 → 12.02 ms; SQL 2,074 → 60. Local workerd listing and repeated stat: 202 → 2 statements, 301 → 101 SQLite rows read. |
| 2. Synchronous materialized-byte write path | Reject | Twenty alternating pairs after four warmups: improvement below 1%; 800-byte and 8,192-byte confidence intervals include no improvement. SQL unchanged. |
| 3. Batch parent lookup cache | Reject | 1,000-file batch creation: 6,004 → 5,005 SQL statements, but a reentrant mutation allowed children under a regular file. Baseline correctly rejects and rolls back. |
| 4. Promise filesystem adapter | Keep, optional | Real add/commit/status/diff/checkout/push/clone pass through the public adapter; permissions, flags, links, read budgets and cancellation tested. Compatibility improvement; no standalone speed claim. |
| 5. Inline/opaque content tier | Keep, optional | A roughly 12 MiB pack fails baseline clone with EFBIG, succeeds with the tier; HEAD and all six 2 MiB file bodies match. Local workerd SQLite/R2 bindings also pass a 9 MiB write/read/range/replacement roundtrip. |

Rejected implementations are archived as patches for reproduction; neither is
included in the library. A regression test preserves the rejected parent-cache
failure case.

## Combined result

Four fresh paired runs, alternating baseline/candidate order, with 1,000 files.
Table entries are medians. Each process starts with fresh databases and remotes.
The combined candidate enables 1, 4 and 5. No compilation or test suite ran
concurrently with these timing measurements.

| Operation | Baseline ms | Combined ms | Baseline SQL | Combined SQL |
| --- | ---: | ---: | ---: | ---: |
| Add all | 306.38 | 276.38 | 20,819 | 19,809 |
| Clean status | 35.25 | 12.69 | 2,074 | 60 |
| One-file diff | 36.43 | 14.16 | 2,087 | 72 |
| Checkout | 48.68 | 23.67 | 2,911 | 618 |
| Commit | 3.52 | 3.49 | 67 | 67 |
| Push | 160.54 | 159.52 | 2,124 | 2,124 |
| Clone | 241.51 | 233.40 | 15,466 | 14,457 |

Clean status pools the second and third clean reads per run; the first read
starts with less metadata cached (38.89 → 22.58 ms; SQL 2,074 → 63).
Repeated status, diff and checkout improve by approximately 64%, 61% and 51%;
their SQL counts fall by 97%, 97% and 79%. Add improves about 10% in this run.
Commit and push are approximately unchanged, and clone improves about 3%.
These smaller timing effects varied across repeated sessions; only the metadata
operations showed large consistent latency improvements. The tier improves
supported file capacity rather than making compression or transport faster.

The diff scenario uses the project's line diff after Git status selection and
blob reads; it is not a benchmark of native `git diff`.

## Compatibility and limits

All original core JavaScript output and the nine original worker bundle sizes
remain unchanged. Existing budgets and benchmark gates are retained. New optional
modules have separate bundle budgets and are excluded from original presets.
There are no new runtime dependencies; isomorphic-git is a pinned development
benchmark dependency.

Final validation: `npm run check` passes (1,782 Node tests and 122 workerd tests,
1,904 total; baseline 1,876). `npm run bench:check` passes the existing Node SQL
gates and all 27 workerd performance tests. Type checks, package consumers,
documentation, quality limits and all 11 bundle presets pass. The optional adapter
bundle is 192,499 bytes; adding metadata and R2 content makes it 202,175 bytes,
within their separate budgets. Existing VFS bundle stays at 183,528 bytes.

Metadata caching requires every writer to deliver committed mutation events to
the cache. It is bound to one filesystem/credential view and invalidates on every
mutation, including permission changes. Opaque listings do not seed stat results.
Caching is disabled unless explicitly configured.

The adapter supports a documented subset of promise filesystem operations. It
returns Uint8Array rather than Node Buffer and does not add descriptors, hard
links or full Node semantics. Timestamps retain the existing VFS resolution;
ctime aliases mtime. The same-second, same-size Git status miss remains. The
existing 1,200-line complete-replacement diff limit also remains.

The content tier preserves existing upload reservations and mutation-token
checks; large writes through symlink paths are unsupported. Full readFile still
materializes the entire permitted body and enforces configured byte budgets.
Passing a 12 MiB pack locally does not establish arbitrary Worker Git memory
capacity.

## Reproduction and raw data

```sh
npm ci
npm run check
npm run bench:check
node bench/fs-evaluation.mjs --base edef5918735e54df5c46e6a5ea5bbfc43b0ff2a2 --trials 3 --output /tmp/cf-vfs-fs-replay
```

The replay rebuilds isolated variants, applies rejected patches only in temporary
checkouts, checks Git outcomes and reproduces batch-cache corruption. It does not
change the retained source implementation. Its manifest records baseline commit,
candidate source digest and Node version.

[Raw measurements](fs-evaluation/) include independent three-trial Git results,
seven-sample primitive results, twenty paired byte-write comparisons, and four
paired combined Git runs. The paired byte comparator can also be replayed with
`bench/fs-byte-compare.mjs` against the baseline and patched build directories.

For four paired combined runs with already compiled directories:

```sh
FS_BASELINE=/path/to/baseline/dist FS_CANDIDATE=/path/to/candidate/dist node bench/fs-git-compare.mjs
```

Do not run builds or other CPU-heavy checks concurrently with timing experiments.
