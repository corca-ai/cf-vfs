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
