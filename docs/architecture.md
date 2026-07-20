# Architecture

`cf-vfs` is an application-level logical filesystem, not an operating-system
filesystem or a POSIX ABI implementation. The
[POSIX-style compatibility profile](posix-compatibility.md) describes the
semantic subset implemented by the architecture below.

## Package boundaries

- `src/core` defines platform-independent paths, filesystem contracts, errors,
  regex and binary-store interfaces, and the command executor.
- `src/commands` contains one independently importable module per command.
- `src/storage/do-sql.ts` implements the filesystem on Durable Object SQLite.
- `src/storage/r2.ts` implements immutable binary storage through an R2 binding.
- `src/durable-object.ts` composes selected commands into typed RPC methods.
- `src/testing/memory.ts` provides a fast in-memory text implementation.

The build preserves this module graph instead of producing one monolithic
bundle. Conditional package exports point to ESM JavaScript and declarations in
`dist`, and `sideEffects: false` lets consumers retain only reachable commands.

## Coordination boundary

One Durable Object is one strongly consistent filesystem. A typical mapping is
one object per workspace, repository, or tenant. All paths and mutations inside
that workspace are serialized by the object's single-threaded execution model;
different objects scale independently.

Do not route all customers to a single object. Cloudflare documents an
individual object's soft throughput limit as 1,000 requests per second, and
body scanning consumes materially more time than a metadata lookup.

## SQL representation

`vfs_entries` is the authoritative path index. It stores absolute path, parent,
basename, kind, content kind/state, logical byte and line counts, mode,
timestamps, revision, and optional R2 key. A unique `(parent_path, name)` pair
models a directory entry.

UTF-8 text bytes are stored in `vfs_text_chunks`, ordered by `(path,
chunk_index)`. The default 256 KiB chunk is comfortably below the current 2 MB
SQL BLOB/row limit and makes `head` and `tail` partial reads possible. The API
reassembles chunks and exposes one logical file.

Paths are normalized absolute POSIX-style strings. `.` and `..` resolve against
the command `cwd`; NUL, names over 255 UTF-8 bytes, and paths over 4096 bytes
are rejected. A trailing slash is preserved as access intent long enough to
require that the resolved entry is a directory, while stored paths remain
canonical. Descendant queries use a lexicographic range rather than a
`LIKE`/`GLOB` prefix, avoiding Cloudflare's current 50-byte SQL pattern limit.

## Paginated traversal

`listPage()` and `findPage()` use canonical paths as keyset continuation
positions. A page materializes at most 1,000 raw entries. Recursive filters are
applied after that bounded scan, which keeps storage and memory work bounded
but means a filtered page is not guaranteed to be full.

A cursor does not hold a SQLite cursor or transaction open across requests and
does not represent a snapshot. Entries inserted or moved before the keyset
position can be missed; entries inserted after it can appear in a later page.
This behavior avoids retaining isolate state and remains safe across Durable
Object eviction.

## Text transactions

Creating or replacing text deletes the previous chunks, writes the new chunks,
and updates metadata inside `transactionSync()`. Each mutation increments the
entry revision. `ifRevision` implements compare-and-swap and prevents a stale
agent from silently overwriting a newer edit.

Text writes can explicitly require creation, replacement, or allow either. A
rename can optionally replace a compatible destination in the same SQL
transaction. If the replaced destination is binary, its immutable R2 key is
queued for garbage collection before its namespace entry is removed.

Appending UTF-8 text adds chunks and updates counts and revision in one SQL
transaction. Touch and metadata changes update entry metadata without rewriting
file bodies. Mode values remain compatibility metadata and are never used for
authorization.

Directory moves update the entry subtree and its text-chunk paths in one SQL
transaction. Text replacement reads and rewrites one logical file atomically.
No cursor is retained across an `await`.

## Binary activation and garbage collection

R2 and Durable Object SQL cannot participate in one transaction. Binary create
therefore uses a recoverable saga:

1. Insert `pending` SQL metadata and a durable garbage-collection key.
2. Upload an immutable, generation-specific R2 object.
3. Activate the SQL entry and clear its GC key.

If upload fails or its outcome is ambiguous, the GC row survives. Removal first
queues object keys transactionally with metadata deletion, then attempts R2
deletion. Failed deletions remain queued for `drainBinaryGarbage()`.

R2 is strongly consistent after a successful binding operation, but that does
not create cross-service atomicity. Generation-specific keys prevent readers
from confusing old and new bodies and avoid R2's same-key concurrent-write
limit.

Binary range reads have both buffered and streaming forms. The streaming form
passes the R2 `ReadableStream` through Workers RPC, preserving flow control and
cancellation instead of accumulating an entire object in isolate memory.

## Deliberate non-goals

The current model has no symlinks, hard links, users/groups, access-control
enforcement, file descriptors, locks, sparse files, extended attributes, or
binary mutation/search. `mode` is compatibility metadata and is not an
authorization system. Existing POSIX applications cannot mount or access this
namespace without an application-specific adapter.
