# String-write optimization — 2026-10-08

String batches now avoid per-file asynchronous collection. Encoded strings are
split into views of one owned buffer instead of copied into a second set of
slabs. SHA-256 also reuses contiguous chunk views, so large unchanged string
writes avoid assembling another body-sized buffer for hashing. The public
APIs, SQL costs, quotas, and commit-time revalidation remain the same.

The collection path also now releases its current lease when hashing fails.
Previously the commit release guard had not yet been installed, so a failed
hash could leave the in-flight byte budget permanently reserved.

## Measurement

Baseline source: `78d7da1e6ee7d913319ec12736733a66648c623b`.
Node: v24.18.0, Apple M5 Max.
The [raw Node report](extension-write-results.json) contains source diff,
compiled-module hashes, sample durations, SQL costs, and paired bootstrap
intervals. Build a baseline dist from that commit separately, build the current
working tree, then run:

```sh
npm run build
EXTENSION_BASELINE=/path/to/baseline/dist node bench/extension-write-compare.mjs
```

Both versions run in one process with separate filesystems. Five warmup pairs
and fifteen measured pairs alternate baseline/candidate order. Bodies and
existing files are prepared outside the measurement. Each sample repeats the
same overwrite or unchanged write; the table divides the median by repetitions.
The comparison asserts identical statement counts, returned rows, result counts,
and published sizes. A byte-array batch is the unchanged-path control. Results
are Node in-memory SQLite timings, not deployed Cloudflare end-to-end latency.

| Workload | Baseline ms/op | Candidate ms/op | Paired candidate/baseline | 95% paired bootstrap interval |
| --- | ---: | ---: | ---: | ---: |
| single-8KiB | 0.0175 | 0.0173 | 0.960 | 0.923–1.050 |
| single-8MiB | 13.2244 | 12.9852 | 0.980 | 0.978–0.995 |
| unchanged-8KiB | 0.0257 | 0.0263 | 1.011 | 0.992–1.034 |
| unchanged-8MiB | 6.9069 | 6.4556 | 0.939 | 0.929–0.942 |
| batch-100-8KiB | 2.1544 | 2.1619 | 0.996 | 0.979–1.013 |
| batch-3-1MiB | 2.7156 | 2.5656 | 0.943 | 0.938–0.949 |
| batch-100-bytes | 1.7821 | 1.7743 | 1.001 | 0.990–1.010 |

Local workerd also compared string collection directly, before SQLite writes.
Run `npx vitest run --config vitest.performance.config.ts
bench/extension-collection.bench.ts --disableConsoleIntercept` (as one command).
Its [raw collection results](extension-collection-results.json) report:

| String size | Async collector ms/op | Owned-view collector ms/op |
| --- | ---: | ---: |
| 8,192 bytes | 0.008 | 0.008 |
| 1,048,576 bytes | 0.060 | 0.040 |
| 8,388,608 bytes | 0.520 | 0.320 |

The 8 MiB collector improves from 0.52 to 0.32 ms (about 38%). This isolates
encoding/chunk collection and includes lease checks and release; it is not an
end-to-end VFS write measurement. Workerd uses millisecond timer granularity,
so each sample repeats 1,000 small or 50 large collections. Small collection
latency ties. Node end-to-end gains are smaller because SQLite writes still
dominate.

The memory improvement is structural: a large string previously retained its
encoded input while allocating another body-sized set of slabs (plus a spare
slab). The collector now allocates only the encoded buffer and small views.
For contiguous chunk hashing, the JavaScript concatenation buffer is also
avoided. Web Crypto's own input snapshot and SQLite's BLOB copies still exist;
no peak-process-memory reduction is claimed without a memory profile.

## Preserved contracts and validation

- String batches retain `heldByCaller` accounting, including `ENOSPC` for an
  oversized batch and `EAGAIN` for temporary competition with other work.
- String getters can execute caller code. Every batch path is still revalidated
  inside the transaction, including paths collected before a later getter.
- Byte arrays, buffers, and streams keep their snapshot/collection paths. No
  caller-owned mutable view is reused as an immutable body.
- Hashing still occurs before opening the publishing transaction. Single
  unchanged writes revalidate after the asynchronous digest; ordinary string
  writes preserve synchronous publication before returning their promise.
- No digest cache, authorization check, quota check, revision rule, or atomic
  publication guarantee was relaxed. SQL counts remain exact in the paired
  comparison and existing performance guards.
- Focused tests cover multibyte strings crossing chunk boundaries, body getters
  mutating an earlier batch path, oversized batches releasing all leases, and
  failed single/batch hashing releasing the current lease. Digest cases cover
  contiguous subviews, gaps, reordered views, separate buffers, and empty input.

Validation: `npm run check` passed 1,831 Node tests and 125 workerd tests;
`npm run bench:check` passed its Node guards and 31 workerd benchmark tests.
Focused Node and local workerd collection tests also passed. The complete check includes package consumers,
POSIX semantics, source quality, and all eleven tree-shaking/bundle presets.

Aggregation, range selection, and directory pagination were not changed: the
[preceding evaluation](extension-api-evaluation-2026-10-08.md) already showed
that those paths avoid the dominant full-materialization work. Pagination's
scanned-row and continuation contracts preclude simply filtering more rows in
SQL without changing its behavior. This change targets measured string-write
collection costs instead.


## Bundle cost

A baseline checkout and the candidate both ran `test/check-tree-shaking.mjs`
with the same installed toolchain. The VFS Worker bundle increased from 204,400
to 205,497 bytes: **1,097 bytes (+0.54%)**. The shell-only, interactive-only,
standalone applet, and default-registry presets stayed identical; presets that
include the VFS carry the same additional 1,097 bytes. All eleven presets pass
their existing budgets, and no budget was raised. This small code-size cost
buys removal of body-sized temporary copies and correct buffer release on hash
failure. The measured baseline and candidate preset sizes are recorded in
[the bundle comparison](extension-write-bundles.json).
