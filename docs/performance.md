# Performance

This page separates Cloudflare's platform semantics from measurements collected
while designing `cf-vfs`. The production numbers below support the storage
model, but they are not a release benchmark of every current library command.

## Why synchronous SQL is appropriate here

Durable Object SQL is a synchronous API: `sql.exec()` returns a cursor without
`await`, and query execution blocks JavaScript on that Durable Object's single
thread. This is an intentional exception to the usual recommendation that I/O
be asynchronous.

Cloudflare runs embedded SQLite in the same thread as the Durable Object. There
is no database process or network boundary; cached indexed queries can complete
in microseconds, and a cache miss reaches local SSD. Avoiding promise and event
loop machinery can therefore be faster than making the API asynchronous. The
same property also makes a sequence of SQL statements easy to reason about:
without an `await`, another request cannot interleave and change the observed
state.

Writes also return synchronously to application code. Durability confirmation
is handled by the Durable Object output gate: the program can continue building
its response, but the runtime withholds external messages until preceding
writes are confirmed. If confirmation fails, the success response is not
released.

Sources: Cloudflare's [zero-latency SQLite design
article](https://blog.cloudflare.com/sqlite-in-durable-objects/), current
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
and [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

## N+1 queries are different, not free

The conventional N+1 problem is dominated by repeated database network round
trips. Embedded SQLite has no such round trips. Cloudflare explicitly shows 100
indexed child lookups following one parent query and states that this can
perform about the same as a join. For clarity, `cf-vfs` may therefore use a
small sequence of simple indexed queries when it expresses the filesystem
operation more directly.

This is not permission to ignore query cost:

- every statement still consumes CPU and SQLite virtual-machine work;
- rows read and written affect billing, and every updated index row counts as
  another row write;
- an unindexed lookup or repeated full scan remains expensive;
- materializing large cursors and file bodies consumes the Worker's memory;
- long synchronous work blocks other requests to the same workspace object.

Use joins, range scans, or batching when they reduce rows or repeated scans.
Do not contort a clear indexed lookup solely to minimize statement count. In
this architecture the useful review question is "how many rows and bytes are
visited?", not just "how many SQL calls are present?".

## Production design benchmark: July 19, 2026

The `rwxweb` investigation measured one SQLite-backed Durable Object with
filesystem metadata and 20,000-byte text files. Three independent objects were
measured at each corpus size. Times are client-observed medians around the full
Worker-to-DO RPC, with the three-run range in parentheses.

| Files | Logical text | Create | Full regex search | Corpus find/replace |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 20 MB | 2.114 s (1.905–2.128) | 225 ms (214–264) | 270 ms (258–642) |
| 5,000 | 100 MB | 6.247 s (6.091–6.300) | 312 ms (292–336) | 468 ms (442–572) |
| 10,000 | 200 MB | 11.753 s (11.644–12.568) | 424 ms (392–470) | 701 ms (644–813) |

Median effective throughput was 9.5–17.0 MB/s for creation, 88.9–471.5 MB/s
for regex scanning, and 74.0–285.1 MB/s for the replacement pass. Apparent scan
throughput rises with the corpus size because every measurement includes fixed
network and RPC latency. All runs traversed a LAX edge; they are end-to-end
values, not isolated SQLite timings.

The corpus stored metadata in one table and ordered text chunks in another,
using the same 256 KiB chunk policy as this library. Each small benchmark file
occupied one chunk. One file in every 100 matched the predictable ECMAScript
regex `search-(?:target)-rwxweb`. Search joined entries and chunks in file/chunk
order, reconstructed one file at a time, and ran the regex inside the Durable
Object. Replacement paged up to 250 files and atomically rewrote only matches.

The current library's recursive `grep` follows the same storage and
reconstruction model. Its `sed` command replaces one named file, not an entire
corpus, so the corpus replacement result is design evidence for a possible
future bulk API rather than a direct `sed` measurement.

## Correctness and storage overhead

All nine benchmark cases verified exact file, chunk, and logical byte counts,
expected match counts, removal of the old marker, insertion of the new marker,
and revision increments without a logical-size change.

| Files | Logical bytes | SQLite bytes | Overhead over text |
| ---: | ---: | ---: | ---: |
| 1,000 | 20,000,000 | 20,676,608 | 3.38% |
| 5,000 | 100,000,000 | 103,256,064 | 3.26% |
| 10,000 | 200,000,000 | 206,503,936 | 3.25% |

This overhead includes the minimal metadata table, paths, chunk primary key and
index, and SQLite pages. A richer schema, history, or additional indexes will
change it.

## Measurement caveat: deployed timers

In deployed Workers, `performance.now()` and `Date.now()` advance only when I/O
occurs. Synchronous CPU and SQL phases may therefore appear to take zero time.
The benchmark used a Node monotonic clock around each HTTPS RPC. Local workerd
timers do advance normally; its diagnostic 1K/5K/10K search times were 12, 63,
and 127 ms, but local results are not substitutes for production latency. See
[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/).

## Platform limits that shape the library

As of July 19, 2026, current documented limits include:

- 10 GB per SQLite-backed Durable Object on Workers Paid; the Free-plan FAQ
  documents 1 GB per object and 5 GB total account storage;
- 2 MB per SQL string, BLOB, or row; 100 KB statements; 100 bound parameters;
  and 50-byte `LIKE`/`GLOB` patterns;
- 30 seconds default CPU per request, configurable to five minutes, and a soft
  1,000 requests/second limit per individual object;
- 128 MB Worker isolate memory;
- R2 single-part uploads just under 5 GiB, multipart objects just under 5 TiB,
  up to 10,000 parts, and one same-key write per second.

Always verify changing limits against [Durable Object
limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
and [R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

## Scaling interpretation

The 200 MB result supports one Durable Object per ordinary workspace at that
scale. It does not show that arbitrary multi-gigabyte workspaces, pathological
regexes, or concurrent scans are safe.

- Metadata commands should remain indexed and body-free.
- `head` and `tail` should stop after enough chunks; `cat`, regex `grep`, and
  replacement currently materialize one whole logical file.
- Keep a configured per-text-file limit below the Worker memory budget. The
  library defaults to 32 MiB.
- Treat full-tree regex as cooperative workspace work. For larger corpora,
  expose versioned pages or jobs so one scan does not monopolize the object's
  single thread.
- Use FTS5 only as an optional literal candidate prefilter. Always verify the
  requested regex against reconstructed file text to preserve API semantics.

Benchmark limitations: three warm trials per size, synthetic ASCII files, a
predictable linear regex, no concurrent users, no cold-start isolation, no R2
binary path, and no pricing measurement.
