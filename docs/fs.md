# Promise filesystem adapter

`@corca-ai/cf-vfs/fs` provides `createFsAdapter(vfs)` for consumers that expect
an `fs.promises`-shaped filesystem. It runs in Workers and Node without
importing Node's filesystem, shell commands, R2, or a Git implementation.
The adapter uses the VFS namespace, credential checks, inline limits, guards and quotas.

```ts
import { createFsAdapter } from "@corca-ai/cf-vfs/fs";

const fs = createFsAdapter(fileSystem);
await fs.promises.mkdir("/project");
await fs.promises.writeFile("/project/readme", "hello");
const text = await fs.promises.readFile("/project/readme", "utf8");
```

## Supported subset

The adapter supports `readFile`, `writeFile`, `stat`, `lstat`, `readdir`,
`mkdir`, `unlink`, `rmdir`, `rm`, `rename`, `chmod`, `readlink`, `symlink`,
`appendFile`, `open`, `truncate`, and `link`.
Methods return promises; there is no callback interface. Paths are strings,
resolved against `cwd` (default `/`). VFS namespace and credential checks remain
in force. `readdir({ withFileTypes: true })` supplies file/directory/link
predicates without an additional lookup per entry.

Binary reads return `Uint8Array`. Text encoding is UTF-8 (`utf8` or `utf-8`);
other encodings are refused. Read flags support `r`; write flags support `w`,
`wx`, `a`, and `ax`. Append operates on inline files and creates an absent file. The optional content
tier supports opaque append by streaming a replacement object. Mode options on `writeFile`
apply only when creating a file. Exclusive creation refuses existing links,
including dangling links. Recursive removal requires an explicit option.

This is a documented subset, not the complete Node filesystem. Local descriptors
support positional inline I/O, truncate, sync/datasync and shared inode lifetime.
Abort options and Node-specific buffer/URL path forms are not provided. VFS errors retain their
codes, including optimistic conflicts (`EREVISION`). `Stats` includes size,
mode, inode, nlink, uid/gid, mtime, ctime, birthtime, revision and mutationToken.
The VFS stores ctime independently of mtime. Consumers that compare only
whole-second timestamps can miss same-sized edits within that second. Revision
is available to consumers that support explicit cache invalidation.

`readFile` materializes a complete body into one allocation, validating the
reported size. `maxReadFileBytes` defaults to the existing 8 MiB inline limit;
`maxInFlightReadBytes` defaults to 32 MiB. Reservations cover concurrent
materialization, not buffers retained by callers after the promise resolves.
Neither limit increases the underlying VFS inline limit. Failure cancels the
source stream and releases its snapshot budget.

## Optional metadata reuse

```ts
import { FsMetadataCache } from "@corca-ai/cf-vfs/fs/metadata";
import { createFsAdapter } from "@corca-ai/cf-vfs/fs";

const metadataCache = new FsMetadataCache(4096);
const fileSystem = new DurableObjectFileSystem(storage, {
  onEvent: metadataCache.onEvent,
});
const fs = createFsAdapter(fileSystem, { metadataCache });
```

Wire the cache to **all** committed mutations of the filesystem before reading.
When composing another observer, deliver the event to the cache first and
then call that observer. Independent wrappers/instances writing the same SQLite database must
also deliver their events to this cache. If complete delivery cannot be
established, leave metadata caching disabled. External SQL writes are outside
this contract. `clear()` permits explicit invalidation at a host boundary.

The bounded cache holds metadata only, for exactly one VFS/credential view.
`list` supplies child metadata after the VFS's read/search permission checks;
subsequent `lstat` and non-link `stat` calls reuse it. Opaque listings do not
prime the cache because direct opaque stats additionally fetch object metadata.
Following a link does not cache its target under the link's name. Trailing-slash
assertions still go through the VFS. Existing-file content overwrites invalidate only the affected paths, including
hard-link aliases. Namespace and metadata changes still clear the cache,
including ancestor permission changes, subtree moves/removals and link repoints.
If the cache has evicted entries since its last clear, content writes also clear
it: preserving a tail of an oversized working set would make the next sequential
scan evict entries it has yet to visit.
Rolled-back changes are not announced and do not invalidate committed metadata.
Errors and file bytes are never cached. Cache eviction changes only cost.

## Optional immutable content tier

```ts
import { TieredFileContent } from "@corca-ai/cf-vfs/fs/content";
import { R2OpaqueStore } from "@corca-ai/cf-vfs/storage/r2";

const store = new R2OpaqueStore(env.BUCKET);
const fileSystem = new DurableObjectFileSystem(storage, { opaqueStore: store });
const content = new TieredFileContent(fileSystem, store);
const fs = createFsAdapter(fileSystem, {
  content,
  maxReadFileBytes: 32 * 1024 * 1024,
});
```

The host explicitly chooses this tier and supplies the same trusted immutable
store configured on the VFS. Materialized bodies above `inlineBytes` (default
8 MiB) use the existing reserve/upload/verify/commit protocol. Smaller bodies
remain inline. A custom inline VFS limit must be matched by `inlineBytes`.
There is no automatic tiering in the VFS core. A streaming write remains inline
unless the caller explicitly requests the opaque tier:

```ts
await content.write("/artifact", bodyStream, { storage: "opaque" });
const { stream, stat } = await content.open("/artifact", { offset: 1024, length: 4096 });
```

`open` preserves full-size metadata for ranges, acquires a read lease before
contacting the store, and streams rather than materializing. Consume or cancel
returned streams. Lease expiry, missing bodies, truncated/oversized transfers
and transport failures are errors. Cancellation reaches the upstream stream;
retention expires through the existing VFS lifecycle. `leaseMs` and `now` can
be supplied when the host uses a custom clock.

Large writes enforce dispositions and pathname CAS; failed uploads use the
existing abort/GC lifecycle. Opaque writes through symlinks and dot components persist both the canonical
path token and a traversal guard. Repointing a traversed link or changing a
visited directory before commit rejects publication. Opaque append streams
the old body and suffix into a replacement object; it rewrites the full body. Credential views can read permitted opaque
bodies but cannot administer uploads. No capability exposes a bucket handle.

Whole-file `readFile` still allocates the entire body; stream/range callers avoid
that allocation. The Git engine in the local benchmark still assembles packs
in memory. Large-file support is therefore not a claim that arbitrary Git
workloads fit a Worker isolate's memory budget.

See the [independent evaluation](../bench/fs-evaluation-2026-10-08.md) for costs,
accepted and rejected experiments, and remaining compatibility limitations.

## Dot components and remaining POSIX gaps

The VFS and promise adapter resolve symlinks before applying `.` or `..`,
including dot components inside link targets. A prefix must exist and be a
directory; credential views also require search permission on directories
visited before returning through `..`. Metadata caches do not substitute a
lexical lookup for these paths. Ordinary paths keep the existing indexed SQL
lookup costs.

Metadata persists separate mtime/ctime and updates parent directory times on
namespace changes, once per parent per transaction. The adapter supplies local
`open`, positional `read`/`write`, `truncate`, `sync`/`datasync`, and `link`.
Descriptors reference a shared inode through rename and unlink. Last-unlinked
inline content counts against quota until the last close; owner restart reclaims
orphaned descriptors. Handles belong to one SQL owner and cannot cross RPC or
survive eviction. Instantiate one owner per database. Custom hosts await `fileSystem.initialize()`
at startup to schedule recovered opaque garbage. `VfsDurableObject` does this
inside its initialization barrier.

`sync` waits for the backing storage's durability barrier when provided;
Durable Object storage supplies it. The Node testing backend is in memory.
Hard links currently replicate inline chunks per name and charge that storage
against inline quota. Triggers are installed only when hard links are used.
Immutable opaque bodies share object references. Positional opaque writes and
opaque descriptor truncate remain unsupported; streaming opaque append replaces
the object and therefore costs O(file size). These are storage model limits,
not a claim of complete POSIX compliance. The shell preserves physical dot
traversal for file operands; `cd` retains Bash's logical-directory behavior.

## Optional bulk-operation eligibility

The underlying `VirtualFileSystem` can expose
`canUseBulkOperation(operation, path): boolean`. `"copy-source"` means recursive
copy of that path sees the same bytes as individual reads, including descendants;
`"write-target"` means `writeFiles` can replace `writeFile` for that target without
bypassing overlays. This read-only hint neither authorizes nor reserves an
operation. Missing methods and false results select individual I/O.

SQL implementations report eligibility. The collaborative wrapper refuses open
documents (and open descendants for copy), including through resolved aliases.
Wrappers that change read/write behavior must override or omit the hint rather
than blindly forwarding it. Callers must still enforce permissions, modes,
budgets and quotas, and hosts must serialize changes to overlays and repositories
with the operation. These hints are an optional VFS extension, not a new method
on `fs.promises`.

### Incremental host metadata index

`FsMetadataIndex`, imported from `/fs/metadata`, combines the existing
`changesSince` and paginated namespace reads. The first `refresh()` returns the
namespace; later calls return `{ updated, removed }` for paths changed since the
last successful refresh. `snapshot()` copies the current indexed metadata.

```ts
import { FsMetadataIndex } from "@corca-ai/cf-vfs/fs/metadata";

// The host creates this VFS with recordChanges: true.
const index = new FsMetadataIndex(trustedFileSystem, 100_000);
const { updated, removed } = index.refresh();
// Update a search/build/synchronization index from these deltas.
```

This is an opt-in, in-memory host index, not an authorization cache. It requires
the trusted filesystem capability: credential-bound views continue to reject the
workspace feed, including for UID 0. Never pass these snapshots to a less trusted
caller without applying that caller's policy, or use them to authorize an actual
file read. Bodies are not retained and final symlinks are not followed. A restart
rebuilds the index. Flush pending document overlays before refreshing: the feed
tracks committed storage changes. Refresh is synchronous and intended for a local VFS, not an
asynchronous RPC stub. Use the existing one-owner-per-database model: multiple
independent mutating engines over one database do not share the existing change
sequence and inode allocation caches, so their feed is not a safe index source.

Capacity defaults to 100,000 namespace entries. A refresh also bounds the number
of distinct changed paths to the larger of capacity and 1,000. Overflow or an
unexpected read failure leaves the previous index and cursor intact. The change
feed must remain enabled for the lifetime of the index; its extra mutation cost
is paid only by workspaces that explicitly enable `recordChanges`. The index
does not enable it automatically. Initial indexing costs a full namespace/feed
read; enabling the feed also adds writes. Fewer refresh reads do not by themselves
imply a smaller bill, especially for write-heavy workspaces.

### Optional batch metadata lookup

`fileSystem.statMany?.(paths, { follow: false })` performs bounded `lstat`-style
reads; omitting `follow: false` selects `stat` semantics. It accepts at most 1,000
paths, preserves input order and duplicates, and returns one `{ stat }` or
`{ error: { code, message, path? } }` per path. Missing paths and permission errors
are individual results; malformed batches and unexpected engine failures throw.
Existing filesystem implementations can omit the capability. No file body or
read authorization is implied by metadata access.

The SQL backend checks each path with the same credentials as ordinary reads.
Complex paths and symlink resolution retain the ordinary implementation. Opaque
object metadata still uses ordinary hydration after the batch lookup and can
require additional reads; this is not a fewer-reads guarantee for every path
class. The
optional Git applet coalesces overlapping metadata reads; shell roots, reserved
paths, execution budgets, and fatal permission refusals still apply.

### Optional bulk body read

`fileSystem.readMany?.(paths, { maxBytes })` reads whole inline file bodies for
a caller that reads many files in a row, such as a recursive walk. It accepts at
most 1,000 paths, preserves input order and duplicates, and returns one
`{ stat, chunks }` per path it read in bulk, where `chunks` are the stored
chunks `readFile`'s stream would yield, in order, and owned by the caller. Every
other path is `undefined`: missing, refused, a directory, opaque, behind a
symbolic link anywhere in the workspace, or past `maxBytes` (default and cap
1 MiB). The caller reads those with `readFile`, which reports the authoritative
result, so the capability changes cost and never an answer. Existing filesystem
implementations, including the collaborative overlay, can omit it.

The SQL backend applies `readFile`'s traversal and read-permission checks to
each entry and spends two statements per 64 paths: the entries, then the bodies
of those it admits, so a refused or oversized body is never materialized.

`fileSystem.changeGeneration?.()` is a counter that moves whenever a statement
that may change the storage runs, through any filesystem over the same storage;
reads leave it still. The shell reads ahead with `readMany` and hands out a body
only while the counter has not moved since, so a command gets exactly what
reading the file at its turn would give, even when it writes a later operand
itself. `grep`, `cat`, `wc`, `sed`, `awk` and the other operand utilities,
`grep -r` and `awiki` read this way. On Workers a stream per file costs about 0.15 ms
and dominates a walk over many small files; bulk bodies are consumed without
one ([measurements](../bench/sql-lab/report-2026-10-30.md)).
