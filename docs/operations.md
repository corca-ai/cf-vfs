# Operations and security

## Workspace placement

Use one Durable Object per logical workspace or tenant and route with a stable
name. A recursive scan is synchronous work on that object's single thread, so
large searches delay interactive operations for that workspace but do not
block other workspace objects.

## Text size and memory

The default text chunk is 256 KiB and the default logical text-file limit is 32
MiB. `head` and `tail` fetch partial chunks. `cat`, regex search, and replacement
currently reconstruct one full file in memory, so increasing the limit must be
evaluated against the Worker's memory limit and all other live allocations.

UTF-8 is validated on read. Byte-limited text slices round inward rather than
returning an invalid partial code point.

## Regular expressions

Fixed-string search needs no regex engine. Regex support is injected explicitly.
The provided native ECMAScript engine has a pattern-length limit but cannot
prevent catastrophic backtracking. Do not expose it to arbitrary untrusted
patterns without additional syntax and input restrictions.

For untrusted inputs, implement the small `RegexEngine` interface with a
linear-time RE2-compatible engine. Whatever engine is selected must report the
first match column and preserve the documented replacement behavior.

## Cursors and transactions

Consume every SQL cursor synchronously with iteration, `.toArray()`, or `.one()`
before the next `await`. Cloudflare documents that a cursor retained across an
`await` has no stable snapshot and can observe later, even eventually rolled
back, writes.

Use `transactionSync()` for related SQL reads and writes. Its callback must be
synchronous and cannot include R2, `fetch`, KV, or other promises. Never hold
`blockConcurrencyWhile()` across external I/O.

## R2 maintenance

Binary uploads use immutable generation keys and leave recoverable GC records
when activation is incomplete. Call `drainBinaryGarbage()` from an alarm or a
bounded maintenance task. Deletion is idempotent; failed keys remain queued.

R2 binding writes and deletes are strongly consistent once their promises
resolve. The SQL/R2 saga is still necessary because no transaction spans the
two services. See the [R2 consistency
model](https://developers.cloudflare.com/r2/reference/consistency/).

## Revisions and concurrent agents

Read the current revision and pass it as `ifRevision` to `write` or `sed` when a
change depends on previously read text. A stale revision produces `EREVISION`
instead of overwriting a concurrent update.

The R2 upload introduces an `await`, so another RPC can run before binary
activation. Pending state and the GC queue make upload/remove races recoverable.

## Output and result limits

Command stdout defaults to 1 MiB and is hard-capped at 8 MiB without splitting
UTF-8 code points. `find` and `grep` also cap result counts. Structured data is
not byte-capped, so request `output: "text"` for potentially large agent-facing
results or add an application-level pagination policy.

Command stdin is opt-in and uses the same default and hard byte limits. Unlike
stdout, oversized stdin is rejected rather than truncated so a transform never
observes an ambiguous prefix. Passing stdout to another command is an explicit
application action; the executor does not interpret pipes or redirection.

Recursive workspace commands also have entry-count limits. `tree` and `du`
report whether their traversal was truncated. `diff` checks file metadata
before reading bodies, defaults to 1 MiB per file, has an 8 MiB hard limit, and
rejects comparisons whose line matrix would exceed one million cells.

`sha256sum` streams binary bodies into Workers `DigestStream`, so memory use is
not proportional to the R2 object size. The command still defaults to a 32 MiB
per-file work limit and permits an explicit limit up to 256 MiB because hashing
CPU remains proportional to input size. `cmp` similarly streams both inputs and
has a 64 MiB hard per-file limit. `join` has a separate row limit to bound the
Cartesian expansion of duplicate keys.

For larger or incremental consumers, use `listPage()` or `findPage()` and keep
following `nextCursor`, including across empty filtered pages. Pagination is
mutation-tolerant but not snapshot-isolated: a rename or insertion before the
cursor can be skipped, while a later key can still appear. Restart traversal
when the application requires a fresh complete view.

## Storage exhaustion

When a SQLite-backed object reaches its storage ceiling, writes fail with
`SQLITE_FULL`; reads and deletes remain available. Translate this into an
application error and allow cleanup rather than repeatedly retrying the same
write. Monitor per-workspace logical bytes and database size before reaching
the platform limit.
