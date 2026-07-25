# Architecture

`cf-vfs` keeps one strongly consistent pathname namespace per SQLite-backed
Durable Object and separates two explicit content classes:

```text
Bash-compatible source
  -> complete parse and deliberate expansion
  -> shell session + virtual byte file descriptors
  -> explicit command registry + scoped VFS
  -> SQLite namespace
       |- inline: bounded shell-readable byte chunks
       `- opaque: metadata reference to immutable R2 content

metadata Durable Object: paths, tokens, upload CAS, leases, GC intent
upload/download gateway: R2 body bytes; not relayed through metadata DO
```

R2 is a capacity and transfer tier, not merely a latency optimization. A
SQLite-backed Durable Object has a finite per-object database capacity, while
workspace bodies can exceed it. Inline SQLite content therefore remains a
bounded, shell-readable working set; opaque R2 generations carry larger or
long-lived capacity without passing their bytes through the metadata object on
the upload and download path. Shell reads are the declared exception; see
"Opaque body access from the shell".
The application chooses the content class explicitly rather than relying on an
automatic size crossover.

## Package boundaries

- `src/core` contains path, glob, error, diff, and unified-patch primitives.
- `src/vfs` contains the byte contract, stream helpers, one adapter-driven
  SQLite implementation, the Durable Object storage adapter, opaque facade,
  and VFS DO base.
- `src/shell` contains versioned Bash-compatible parsing, expansion, and arithmetic,
  manual pipe pumps, sessions, sourced-unit execution, redirections, budgets,
  capability policy, and execution APIs.
- `src/shell/interactive.ts` is a separate public entry point that owns
  persistent-session lifecycle and complete-source input buffering while
  reusing the ordinary shell executor.
- `src/shell/commands` contains argv-based built-ins and utilities. The full
  registry is a separate module.
- `src/storage/r2.ts` is the immutable `R2OpaqueStore` adapter.
- `src/testing/node.ts` adapts Node 24's built-in in-memory SQLite to the same
  SQL VFS for local tests and tools. `src/testing/opaque-store.ts` is the
  deterministic R2 substitute.

The root and `/vfs` exports do not import shell code. The `/shell` export does
not import the interactive adapter or Durable Object platform code.
`/shell/interactive` opts into persistent sessions explicitly. Worker-only
bases are under `/durable-object`. Package and Wrangler tests verify those
boundaries. The Node-only SQLite adapter has its own `/testing/node` subpath so
it cannot pull `node:sqlite` into a Worker bundle.

`src/vfs/sql.ts` owns all filesystem semantics and depends only on a narrow
synchronous SQL, transaction, database-size, and alarm port.
`src/vfs/do-sql.ts` maps that port to `DurableObjectStorage`; the Node testing
adapter maps it to `DatabaseSync(":memory:")` and an in-process alarm slot.
Cloudflare integration tests remain authoritative for platform-specific cursor
metering, output gates, alarms, RPC, and eviction.

## Inline files

An inline file is arbitrary bytes, not necessarily UTF-8. SQLite stores fixed
chunks under a stable entry ID. A file is limited to 8 MiB. The default 256 KiB
chunk stays well below Cloudflare's 2 MB SQLite BLOB/row ceiling; the Durable
Object backend rejects chunk configurations above 1 MiB.

Read behavior:

1. Execute and fully consume the ordered SQLite chunk query synchronously.
2. Copy the bounded result to establish a snapshot.
3. Account it against the instance-wide in-flight byte budget.
4. Return a `ReadableStream<Uint8Array>` that releases the budget on completion
   or cancellation.

A later replace or unlink cannot change the active snapshot. No read refcount,
lease, immutable inline generation, staging table, or inline GC exists.
Callers must consume or cancel returned streams.

Write behavior:

1. Collect directly into fixed-size slabs while enforcing file and shared
   in-flight limits.
2. Capture and later recheck the pathname mutation token.
3. In one short `transactionSync()`, validate quota and headroom, replace chunk
   rows, update metadata and usage, and publish one new revision/token.
4. Release the buffered-byte reservation before any external await.

Append keeps existing full chunks in place. It reads only the final stored
chunk, fills that tail, and inserts any new suffix chunks in the same
transaction.

No cursor or SQLite transaction crosses an `await`. `SQLITE_FULL` is translated
to `ENOSPC`. Per-workspace inline logical bytes, entry count, database
headroom, and per-instance materialized bytes are separate limits.

## Namespace and ABA protection

`vfs_entries` is the namespace source of truth and uses compact SQLite
`INTEGER PRIMARY KEY` identities. `vfs_state` owns a random workspace epoch.
`vfs_path_versions` owns a monotonic version per path and retains it as a
tombstone even while that path is absent; the public token combines epoch and
the path version. A single UPSERT increments an ordinary path mutation.
Set-based subtree mutations increment all affected path versions inside
SQLite. Every create, content replace, metadata update, move, and delete
therefore changes the relevant token. An absent → create → delete sequence
invalidates a reservation captured while absent.

The schema also contains:

- `vfs_inline_chunks(entry_id, chunk_index, body)`;
- `vfs_opaque_objects` with R2 key, size, ETag, version, optional verified
  digest and MIME type, and read-retention deadline;
- `vfs_upload_sessions` with `open`, `verifying`, `committed`, and `garbage`
  states plus CAS token/lease and idempotent receipt;
- `vfs_gc_queue` with due time, attempts, retry time, and last error;
- `vfs_usage` for atomic logical-byte and entry quotas.

Checks and triggers reject invalid directory/content/link combinations,
dangling opaque references, orphan inline chunks, and deletion of referenced
content. An entry is a directory, a file with exactly one content class, or a
symbolic link with a non-empty target; SQLite refuses a row that is two of
those at once, so a caller that has forgotten the rule cannot write one.
Opaque liveness is derived from the indexed entry rows with `NOT EXISTS`; no
stored reference count can drift.

Recursive namespace mutations stay inside SQLite. Copy uses `INSERT ... SELECT`
for entries and an entry-ID join for inline BLOB chunks, move uses one range
`UPDATE`, and remove uses set-based token publication, GC queuing, and range
deletes. JavaScript receives only aggregate counts and result metadata.

## Symbolic links and pathname resolution

`vfs_entries` holds a link as `kind = 'symlink'` with the target stored in
`link_target` exactly as it was supplied. The target is never rewritten: a
relative target is what makes a subtree relocatable, and it resolves against
the directory holding the link rather than against any caller's working
directory.

Resolution happens in exactly one place, and every operation reaches the table
through it. That is what keeps a policy check, the loop bound, and the relative
target rule from being bypassed by a caller who has not thought about links.
The path a mutation writes is always the canonical one, so a link can never
become the parent of an entry — which in turn is what lets an exact-path lookup
be trusted without walking components.

The cost is deliberately shaped so a namespace without links pays nothing.
Resolution first asks whether any link exists; at zero it does no lookup at
all, and `stat`, `readFile`, and `getMutationToken` cost exactly the statements
they cost before links existed. A test pins those counts absolutely.

Above zero, resolution keeps the row it landed on, so an operation that needs
the entry — `stat`, `readFile`, `remove`, `move`, `copy` — still costs one
lookup. An operation that needs only the canonical path, such as
`getMutationToken`, costs one more, because it has no use for the row. A path
whose final component is absent costs one further query: a single
`path IN (…)` over its ancestors, served by a partial index on links alone,
rather than one query per component. A chain costs one lookup per hop and is
bounded at forty hops, so a cycle ends in `ELOOP` rather than in a hang.

The link and its target are separate paths, so they carry separate revisions
and mutation tokens: writing the target does not disturb the link's token, and
replacing the link does not disturb the target's. A guard taken on a path that
crosses a link covers the whole chain — the target's version and each link's —
because the path means whatever the links currently say. Without that,
repointing a link between the read and the write would be invisible whenever
the old and new targets happened to share a version, which is precisely the
ABA the token exists to catch. `getMutationToken(path, { follow: false })`
reads the link's own token instead, for a caller replacing the link itself.

## Opaque R2 lifecycle

R2 keys are random generations independent of paths:

```text
vfs/{workspace-id}/objects/{random-generation-id}
```

Upload protocol:

1. `beginOpaqueUpload()` captures the current path token, persists an expiring
   `open` session, allocates a one-write key, and schedules the earliest alarm.
2. A gateway or direct binding path uploads bytes to R2. `R2OpaqueStore` uses a
   conditional create, so the generation cannot be overwritten. Direct
   bindings are trusted; gateway authority is key-scoped and expires with the
   reservation.
3. `commitOpaqueUpload()` synchronously claims `open -> verifying` with a
   unique token and lease, then performs R2 `HEAD` outside SQL.
4. A second short transaction rechecks the verification lease and pathname
   token, stores server-observed size/ETag/version, publishes the opaque entry,
   and persists a receipt. A successful retry returns that receipt during its
   bounded retention window.
5. Expiry, abort, failed validation, a lost lease, or a stale path makes the key
   durable GC work before the failure is returned. Deletion is not eligible
   until upload authority has expired plus a settlement grace, preventing a
   late in-flight PUT from recreating a just-deleted generation.

Client assertions never establish a digest. A digest is exposed only when a
trusted store or gateway verified it against the bytes. The metadata DO never
accepts or returns the large body.

Opaque copy inserts another namespace reference and performs no R2 operation.
Move updates SQLite paths only. Replacing or removing the last reference moves
the object key to GC in the same namespace transaction.

## Opaque body access from the shell

This section revises the boundary the diagram above states. Uploads and
downloads still move bytes between the client and R2 directly, never through
the metadata object. A shell command reading an opaque body is the one
exception, and it is opt-in twice over.

Opaque bodies are unreadable from shell commands by default, and that default
is unchanged by this capability existing. Two independent things must be true
for a command to stream one: the host must construct the shell with a content
reader, and the session's policy must say `opaqueContent: "stream"`. Requiring
both is deliberate — adding the capability to a host is a statement about what
the host can do, not a decision about every session running on it.

`ShellContentReader` is the narrowest capability that works: it opens one body
for one path the namespace already names. There is no listing, no upload, no
key construction, and no bucket handle, so a command holding it cannot
discover an object the namespace does not name, create one, or delete one.
The R2-backed implementation lives behind its own subpath and is excluded from
every bundle preset, including the one that imports every applet — an
inline-only shell carries none of it.

### Where body-dependent execution happens

**In the namespace Durable Object, using a leased R2 stream — not in a caller
Worker.** The Worker-side alternative already exists and stays: `readOpaque()`
takes a lease and streams a body outside the metadata object, which is how a
caller downloads one today. What was decided here is narrower — where a *shell
command* reads a body it is going to consume — and it went to the DO for three
reasons.

It would need a second shell authority. A command does not read a body in
isolation: it reads it while resolving paths, checking roots, charging one
shared budget, and writing to descriptors the same execution owns. Splitting
the body out means either shipping those decisions to the Worker — two places
that must agree about policy, which is the failure mode this project designs
against — or shipping every non-body operation back to the DO per command.

It would put the lease further from the authority that grants it. Retention is
a row in the same SQLite that owns the namespace. A read inside the DO takes
one lease and does not renew it either, so a stream slower than the lease can
outlive it in both designs — but renewal is a local call in one and a round
trip in the other. A read that outlasts its lease fails with `EIO` rather than
returning short data.

And the cost it avoids is smaller than it looks. The DO does not buffer: the
bucket's stream is handed straight to the command with the byte count charged
as it passes, at most one chunk in flight. What crosses the DO is what the
command was going to consume anyway, and a command that stops early — `head`,
`grep -q` — stops the read with it.

The ordering that makes this safe is the one `readOpaque()` already uses:
metadata and the retention lease are taken in one short SQL transaction, and
the R2 GET happens after it commits. A bucket round trip inside a transaction
would hold the storage lock for the length of a network call. The ordering is
close to structural — `transactionSync` returns before the `await` that issues
the GET — and a test guards it against a refactor that made the transaction
asynchronous.

### What streams and what does not

A command that consumes its input and emits as it goes may read an opaque
body. A command that must hold all of it may not, and reports `ENOTSUP` — the
refusal lives in the helpers that do the holding (`readFileText`,
`readFileBytes`, `inputTexts`), so it is enforced by construction rather than
by remembering to pick the right generator. `sort`, `diff`, `patch`, `join`,
`comm`, `paste`, `cmp`, `tail`, and `sed -i` all route through one of them.

The argument for the line is a smaller one than it first appears, and worth
stating accurately: the inline limit (8 MiB) and the buffering limit (16 MiB)
are independent, so a barrier *could* hold many opaque bodies. What it buys is
an early, specific refusal instead of a late `E2BIG` partway through — a
caller can branch on the first and can only fail on the second.

Command substitution is not a barrier on the input: `cat` streams the body and
the substitution buffers `cat`'s output under its own limit, exactly as it does
for an inline file.

Ranges are requested where they reduce work — `head -c N` asks for N bytes —
and are advisory. An implementation that cannot serve one returns the whole
body and the caller still truncates, so a store without range support gives
the same answer for more bytes rather than a wrong one.

## Read leases and GC

`resolveOpaqueRead()` extends the object's durable retention time by a bounded
lease (capped at one hour) and returns R2 metadata. `readOpaque()` then obtains
the body directly from the store. Unlink queues deletion no earlier than that
retention time; callers must start the R2 read within the lease.

GC materializes at most 100 due keys, issues one idempotent multi-delete, and
removes queue/session rows in a short transaction. Failure records exponential
backoff and schedules the next alarm before rethrowing. One alarm is always
set to the earliest open-session expiry, verification lease, or GC retry. The
work survives Durable Object eviction.

## Shell and RPC boundaries

The manual raw-`ReadableStream` pipe has byte-sized high-water accounting,
backpressure, cancellation wakeups, ref-counted sinks, and no dependency on
custom `TransformStream` transformer semantics. Pipelines start every stage
before awaiting completion. File descriptor duplication is evaluated
left-to-right.

In-process execution returns `{ stdout, stderr, completed, cancel }`. Remote
`executeTo()` instead accepts explicit stdin/stdout/stderr streams and returns
only an exit status; `executeText()` is the bounded convenience form. This
avoids assuming that a nested execution object has a transferable RPC
lifetime.

Non-interactive and interactive calls share the same complete-unit executor.
`Shell` creates a fresh session for every call. `InteractiveShell` retains one
session and resets only unit-local flow/depth state before the next call.
Descriptors, parser budgets, execution budgets, cancellation, and output
limits are always per unit. Interactive units cannot overlap.

## Migration policy

This pre-deployment, pre-1.0 redesign deliberately replaces earlier local
schemas. The tables use the `vfs_` prefix and require a fresh filesystem;
there is no compatibility migration from the experimental `vfs2_` layout.

Schema initialization is gated by `vfs_schema_migrations`; ordinary Durable
Object restarts perform only the migration-table bootstrap and version check.
Version 2 adds symbolic links. SQLite cannot widen a `CHECK` constraint in
place, so it is the standard rebuild: create the new entry table, copy every
row, swap. The definition is a single constant shared with the fresh schema, so
a migrated database and a new one cannot drift, and the migration test compares
the two directly. The rebuild drops and recreates all six entry-shape triggers, because
`ALTER TABLE ... RENAME` treats them in two different ways: the four attached
to the entry table follow it to its temporary name and are dropped with it,
while the two attached to `vfs_opaque_objects` and `vfs_inline_chunks` survive
with their bodies rewritten to reference a table that no longer exists.
The explicit table is intentional because Durable Objects do not support
[`PRAGMA user_version`](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#initialize-storage-and-run-migrations-in-the-constructor).
A schema change runs `PRAGMA optimize` after its tables and indexes are installed.
