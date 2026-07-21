# cf-vfs documentation

`cf-vfs` combines a byte-oriented virtual filesystem with a bounded,
non-interactive Bash-compatible runtime. The [README](../README.md) is the
short overview; this page is the documentation entry point.

## Start here

- [Getting started](getting-started.md) — install, configure a Durable Object
  and R2, execute source, and transfer opaque bodies outside the metadata DO.
- [Shell, commands, and direct API](commands.md) — Bash Version 4, streams,
  statuses, utilities, opaque behavior, and direct VFS primitives.
- [Architecture](architecture.md) — SQLite inline bytes, immutable R2 objects,
  mutation tokens, upload verification, read leases, and GC alarms.
- [POSIX and Bash compatibility](posix-compatibility.md) — supported behavior,
  deliberate atomic-redirection divergence, and rejected syntax.
- [Operations and security](operations.md) — policy, quotas, cancellation,
  upload trust, monitoring, recovery, and workspace routing.
- [Performance and benchmarks](performance.md) — synchronous snapshots,
  backpressure, output slabs, benchmark scenarios, and measurement caveats.
- [Parser technology spike](parser-spike.md) — why Version 4 uses a
  handwritten parser and what would trigger reconsideration.
- [Development](development.md) — repository layout, complete verification,
  package boundaries, and extending the runtime.

## Public layers

1. `VirtualFileSystem` provides typed byte, namespace, metadata, and opaque
   lifecycle primitives.
2. `Shell` parses complete source and connects virtual file descriptors with
   `ReadableStream<Uint8Array>`.
3. `ShellCommand` utilities receive argv, byte streams, a shared budget, and a
   capability-wrapped filesystem that cannot access opaque bodies.
4. `VfsDurableObject` and `ShellDurableObject` expose the metadata and remote
   execution boundaries. R2 body transfer uses a separate gateway or direct
   binding path.

Current platform references are Cloudflare's [Durable Objects
documentation](https://developers.cloudflare.com/durable-objects/), [SQLite
storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/),
[Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/), and
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
