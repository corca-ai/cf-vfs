# cf-vfs documentation

`cf-vfs` combines a byte-oriented virtual filesystem with a bounded,
Bash-compatible runtime. Independent source execution is the default; a
separate tree-shakable entry point adds persistent interactive sessions. The
[README](../README.md) is the short overview; this page is the documentation
entry point.

## What this library is for

The product is an isolated, deterministic environment an **agent** can be
given: a filesystem it cannot escape and a shell it cannot surprise you with.
Everything below follows from that.

**The core is the VFS and the non-interactive shell.** A Durable Object's
SQLite holds the namespace and answers POSIX-shaped questions quickly and
correctly; `Shell` executes one complete source unit over it with bounded
budgets and no persistent state. That pair is what a caller runs an agent
against, and it is the only part whose size and speed are a product concern.

**The interactive shell is not core.** `InteractiveShell`, the input buffer,
completion, and the browser demo exist for debugging, manual testing, and
showing the runtime to a person. They are useful and they are supported, but
no agent workload runs through them, so they must never be something a
non-interactive consumer pays for — in bundle bytes, in startup, or in the
work one execution does.

### What that costs a change

Three properties are load-bearing, in this order:

1. **Small.** Every applet is independently importable and the shared layers
   below them do not import the commands that use them. A consumer who wants
   `cat` should get `cat`. Bundle budgets are recorded per preset and a
   pull request that moves one explains why.
2. **Fast.** SQLite does set work; JavaScript does not re-derive it. Row and
   statement counts on the common paths are metered and guarded, and a feature
   that is off costs nothing rather than a little.
3. **Tree-shakable.** Interactive, Linux-profile, R2, and demo code sit behind
   their own entry points and are asserted absent from the presets that should
   not carry them. An assertion is what makes this survive the next feature.

Where a convenience and one of these conflict, the convenience is the thing
that moves. A shell that is pleasant to type into by hand and a shell an agent
runs ten thousand times are different products; this repository optimizes the
second and offers the first from a subpath.

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
2. `Shell` parses and executes one independent complete source unit.
3. `InteractiveShell`, from `/shell/interactive`, reuses that executor while
   preserving cwd, variables, functions, options, arguments, and status.
4. `ShellCommand` utilities receive argv, byte streams, a shared budget, and a
   capability-wrapped filesystem that reads opaque bodies only when the host
   supplies a content reader and the session's policy allows it.
5. `VfsDurableObject` and `ShellDurableObject` expose the metadata and remote
   execution boundaries. R2 body transfer uses a separate gateway or direct
   binding path.

Current platform references are Cloudflare's [Durable Objects
documentation](https://developers.cloudflare.com/durable-objects/), [SQLite
storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/),
[Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/), and
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
