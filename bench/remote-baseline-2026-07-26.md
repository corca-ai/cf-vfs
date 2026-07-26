# Deployed opaque-body benchmark baseline — 2026-07-26

Endpoint: `https://vfs.borca.ai`, Worker `cf-vfs-benchmark`, bucket
`cf-vfs-benchmark`, colo `LAX`, profile `quick`, schema version 3. Raw numbers
in `remote-baseline-2026-07-26.json`, which `npm run bench:remote:check`
compares a fresh run against.

This closes the measurement #52 shipped without: the local tests used an
in-memory store, which cannot show what a real bucket costs.

Re-recorded after the redundant reads came out, so the point and subtree
sections below are no longer the 2026-07-24 ones. Append is unchanged.

## Opaque body reads

| | first byte | total | bytes | chunks | max chunk | R2 GETs | SQL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 MiB, whole | 395 ms | 405 ms | 1 048 576 | 256 | 4 096 | 1 | 5 stmt / 7 rows |
| 8 MiB, whole | 455 ms | 643 ms | 8 388 608 | 2 049 | 4 096 | 1 | 5 stmt / 7 rows |
| 8 MiB, `head -c 16` | 336 ms | 336 ms | 16 | 1 | 16 | 1 | 5 stmt / 7 rows |
| 8 MiB, cancelled after one chunk | 533 ms | 533 ms | 4 096 | 1 | 4 096 | 1 | 5 stmt / 7 rows |

## What the numbers say

**SQL cost does not scale with the body.** Five statements and seven rows read,
identical across 16 bytes and 8 MiB. That is the lease and the metadata, taken
in one short transaction before the GET — the ordering the design turns on, now
visible rather than asserted.

**One GET per read, not one per chunk.** The 8 MiB read is 2 049 chunks and a
single R2 operation. Billing and rate limits track reads, not bytes moved.

**Memory is bounded by R2's chunk size, not the object's.** `maxChunkBytes` is
4 096 for both the 1 MiB and the 8 MiB read. Nothing accumulates: the DO holds
one 4 KiB chunk at a time regardless of how large the body is, which is the
property the local `ChunkedStore` test asserts and this confirms against the
real bucket.

**The DO relays rather than stores.** For 8 MiB, 455 ms to the first byte and
643 ms total — about 190 ms of DO time for 8 MiB of transfer, and that time is
spent passing chunks along, not assembling them. This is the number that
decided the architecture question in `docs/architecture.md`: moving the body to
a caller Worker would save that ~190 ms and cost a second shell authority.

**Ranges are served by R2.** `head -c 16` against an 8 MiB object transfers 16
bytes in one chunk. The range is not a local slice of a full download.

**Cancellation stops the transfer.** Stopping after the first chunk transfers
4 096 bytes of an 8 MiB object.

## First-byte latency is dominated by the round trip

330–530 ms to the first byte for every case, including the 16-byte range — so
it is the R2 round trip from the DO, not the body size. The variation between
runs (336–694 ms across four runs) is larger than the variation between sizes,
which means this figure is a network measurement and should not be treated as a
regression signal. The three that *are* stable and worth guarding are the R2
operation count, the SQL cost, and `maxChunkBytes`.

## Reproducing

```
npm run bench:remote
```

Needs `CF_VFS_BENCHMARK_TOKEN` or an ignored `.dev.vars.benchmark`. The opaque
section is omitted entirely when no bucket is bound, rather than reported as
zeros — a missing measurement and a measurement of nothing are different
things, and zeros would read as a regression the day a bucket appears.

Immediately after a deploy the first run can fail with a 500 while the new
version propagates; the server-side log shows the run completing. Retrying once
is enough.

## Structural cost, deployed

The same reductions the [Durable Object baseline](do-baseline-2026-07-26.md)
records locally, confirmed against a real object rather than an in-process
one. Deployed numbers, before and after:

| Operation | before | current |
| --- | ---: | ---: |
| 8-byte overwrite — statements | 13 | 8 |
| 8-byte overwrite — rows read | 21 | 14 |
| subtree copy, 100 files — statements | 11 | 9 |
| subtree copy, 1,000 files — statements | 11 | 9 |

Copy stays constant across the two sizes, which is the property that matters:
the cost answers what the operation is, not how much it moves.

Opaque reads are structurally unchanged — still five statements and one R2 GET
whatever the body size. The 8 MiB read reports 2,048 chunks here against 2,049
before, which is where the stream happened to break, not a change in work.
