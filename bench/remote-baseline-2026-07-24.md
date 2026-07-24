# Deployed Durable Object benchmark baseline — 2026-07-24

Endpoint: `https://vfs.borca.ai`, Worker `cf-vfs-benchmark`, version
`5657305b-82e6-4d60-9164-f0c8fcdf5550`. The table is the median of the
per-run medians from three `quick` runs, each using a fresh SQLite-backed
Durable Object and deleting its storage afterward. The Korean client was
routed through Cloudflare's LAX colo in this environment.

Production Workers intentionally freeze `performance.now()` and `Date.now()`
while synchronous code runs. These timings are therefore observed by the
calling Worker across a Durable Object RPC I/O boundary. They include
same-Cloudflare-network RPC and storage input/output-gate latency. Point
operations are batch-amortized per operation; append and subtree rows are one
operation per RPC. The median empty-RPC observation was 5 ms.

| Operation | Scale | deployed median ms |
| --- | ---: | ---: |
| `stat()` | populated 1,000-file database | 0.040 |
| 8-byte overwrite | populated 1,000-file database | 1.933 |
| filtered `findPage()` | 1,000 files | 7.500 |
| warm schema initialization | populated database | 0.110 |
| tail append | 1 MiB | 48 |
| tail append | 8 MiB | 47 |
| subtree copy | 100 files | 47 |
| subtree move | 100 files | 45 |
| subtree remove | 100 files | 46 |
| subtree copy | 1,000 files | 65 |
| subtree move | 1,000 files | 65 |
| subtree remove | 1,000 files | 50 |

The near-equal 1 MiB and 8 MiB append times corroborate that append no longer
rewrites the existing body. Increasing subtree size from 100 to 1,000 files
raised copy, move, and remove medians by only 1.38×, 1.44×, and 1.09×,
respectively. Their statement counts remained 11, 7, and 10 at both sizes.

The three complete suite RPC times were 7,268, 9,834, and 7,587 ms. This
includes untimed setup, repeated samples, SQL cost diagnostics, and cleanup,
so it is not an individual filesystem-operation latency.

This is the first deployed baseline; there is no production “before” run.
The local before/current comparison remains in
[`do-baseline-2026-07-24.md`](do-baseline-2026-07-24.md). The JSON companion
contains the structural and broad latency thresholds used by
`npm run bench:remote:check`.
