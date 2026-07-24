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
upload/download gateway: R2 body bytes; never relayed through metadata DO
```

## Package boundaries

- `src/core` contains path, glob, error, diff, and unified-patch primitives.
- `src/vfs` contains the byte contract, stream helpers, deterministic memory
  implementation, SQLite implementation, opaque facade, and VFS DO base.
- `src/shell` contains versioned Bash-compatible parsing, expansion, and arithmetic,
  manual pipe pumps, sessions, sourced-unit execution, redirections, budgets,
  capability policy, and execution APIs.
- `src/shell/interactive.ts` is a separate public entry point that owns
  persistent-session lifecycle and complete-source input buffering while
  reusing the ordinary shell executor.
- `src/shell/commands` contains argv-based built-ins and utilities. The full
  registry is a separate module.
- `src/storage/r2.ts` is the immutable `R2OpaqueStore` adapter.
- `src/testing` contains deterministic in-memory VFS and R2 substitutes.

The root and `/vfs` exports do not import shell code. The `/shell` export does
not import the interactive adapter or Durable Object platform code.
`/shell/interactive` opts into persistent sessions explicitly. Worker-only
bases are under `/durable-object`. Package and Wrangler tests verify those
boundaries.

## Inline files

An inline file is arbitrary bytes, not necessarily UTF-8. SQLite stores fixed
chunks under a stable entry ID. A file is limited to 8 MiB.

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

Checks and triggers reject invalid directory/content combinations, dangling
opaque references, orphan inline chunks, and deletion of referenced content.
Opaque liveness is derived from the indexed entry rows with `NOT EXISTS`; no
stored reference count can drift.

Recursive namespace mutations stay inside SQLite. Copy uses `INSERT ... SELECT`
for entries and an entry-ID join for inline BLOB chunks, move uses one range
`UPDATE`, and remove uses set-based token publication, GC queuing, and range
deletes. JavaScript receives only aggregate counts and result metadata.

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
The explicit table is intentional because Durable Objects do not support
[`PRAGMA user_version`](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#initialize-storage-and-run-migrations-in-the-constructor).
A schema change runs `PRAGMA optimize` after its tables and indexes are installed.
