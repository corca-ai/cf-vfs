# Performance and benchmarks

The runtime optimizes for bounded memory, predictable failure, and cloud
backpressure before microbenchmark latency. Run `npm run bench` for the Node
memory-backend scenarios and `npm test -- storage-benchmark` for workerd SQL
metrics. The checked-in [local baseline](../bench/baseline-2026-07-20.md)
records the environment and raw interpretation.

## Stream and storage cost model

Pipeline edges carry `Uint8Array` chunks through a small raw
`ReadableStream` pump with byte-sized high-water accounting. A writer waits
when its downstream queue is full, and cancellation wakes both sides. Stages
start concurrently; the runtime does not materialize a whole pipeline between
commands.

Small command output is coalesced into roughly 64 KiB writes to avoid one
promise/microtask per line. Text decoders preserve partial UTF-8 sequences
across source chunks. Utilities such as `cat`, byte `head`, and `wc` can remain
incremental. `sort`, `diff`, `join`, `patch`, atomic redirection, and whole-file
VFS commit buffer because their semantics require a barrier; separate byte,
line, record, and heap budgets bound that materialization.

Inline VFS reads are intentionally eager. SQLite's synchronous cursor is fully
consumed into at most 8 MiB before a stream is returned, establishing a stable
snapshot without holding a cursor or transaction across `await`. Writes collect
directly into fixed slabs and publish once. This is usually faster and simpler
than a paged pull protocol at this size, but concurrent snapshots and writes
are capped by the instance-wide in-flight budget.

Opaque work is payload-size-independent inside the metadata DO. Upload/download
bytes go directly to R2; the DO performs metadata SQL plus one R2 `HEAD` during
commit. Copy and move perform no R2 body operation. GC batches up to 100 keys
into one idempotent delete request.

## Covered scenarios

The executable benchmark covers:

- 1 KiB, 64 KiB, 1 MiB, and 8 MiB inline write/materialize/read;
- a 1 MiB inline overwrite;
- one-, three-, and six-stage 1 MiB pipelines;
- 16,384 one-byte chunks;
- a 1 MiB line through a buffering utility;
- early downstream cancellation and a deliberately slow 64-chunk consumer;
- four concurrent shell executions;
- 1 MiB opaque begin/put/`HEAD`/commit/unlink/GC; and
- a 64-object GC batch.

Each Node row records median elapsed time after a warm-up, three measured
repeats, heap/ArrayBuffer/external/RSS high-water deltas, output bytes, backend,
SQL fields, logical R2 Class A/B/free-delete operations, and a
marginal Standard-storage operation-cost estimate. SQL fields are explicitly
`null` for the memory backend rather than presented as zero.

The workerd storage benchmark meters `SqlStorageCursor.rowsRead` and
`rowsWritten`, `databaseSize`, and physical inline chunk count for a 1 MiB
overwrite plus snapshot. Cursor metrics are the platform billing-oriented
values; an ordinary `COUNT(*)` is deliberately outside that meter.

## Interpreting the baseline

Local timings are regression evidence, not production latency. Even separate
Node heap, ArrayBuffer, external, and RSS samples can miss synchronous peaks,
and garbage collection can make an observed delta zero. Worker
isolate allocation, DO duration, RPC/edge latency, R2 network time, cold starts,
and concurrent tenants require deployed measurements.

The billing estimates use rates current on 2026-07-20 and show marginal cost
after included usage; they exclude storage duration, DO requests/duration,
Worker cost, multipart requests, retries, and Infrequent Access retrieval or
minimum-duration fees. R2 `PutObject` is Class A, `HeadObject`/`GetObject` are
Class B, and deletes are free according to [R2
pricing](https://developers.cloudflare.com/r2/pricing/). SQLite rows and stored
data follow [Durable Object
pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Durable Object SQL

`sql.exec()` is synchronous because SQLite is embedded beside the object,
without a database network round trip. Keep cursors synchronous and fully
consumed, and keep related mutations in `transactionSync()`. External R2 or
network I/O must occur after that transaction. Cloudflare's output gate handles
durability before external messages are released.

Repeated indexed statements are not free: CPU, rows visited, index updates,
database bytes, and time on the object's single thread still matter. Review
rows and bytes rather than statement count alone. Prefer pagination and range
scans for large namespaces, and use deployed analytics for billed rows.

Current platform constraints include a finite per-object SQLite capacity, a
128 MiB Worker isolate memory limit, SQL value/statement limits, and separate
CPU/request limits. R2 has different single-part, multipart, and same-key write
constraints. Verify changing values in [Durable Object
limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
and [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) before
deployment.
