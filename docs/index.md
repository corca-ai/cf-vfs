# cf-vfs documentation

`cf-vfs` provides a logical POSIX-style filesystem and agent-oriented commands
on top of a SQLite-backed Durable Object and R2. The root
[README](../README.md) is the short overview; this page is the documentation
entry point.

## Start here

- [Getting started](getting-started.md) — install the package, configure
  Durable Objects and R2, and execute the first command.
- [Commands and API](commands.md) — command inputs, outputs, exit codes, direct
  functions, and binary RPC methods.
- [Architecture](architecture.md) — package boundaries, SQL schema, text
  chunking, consistency, and binary garbage collection.
- [Performance](performance.md) — production measurements, synchronous SQL
  semantics, N+1 queries, limits, and scaling guidance.
- [Operations and security](operations.md) — workspace sharding, regex safety,
  memory, output limits, maintenance, and failure handling.
- [Development](development.md) — repository layout, tests, packaging, and
  release preparation.

## Scope

The library supports normalized absolute paths, directories, text files,
immutable binary files, metadata, revisions, recursive search, atomic text
replacement, and a structured command executor. It intentionally does not
model symlinks, hard links, users/groups, open file descriptors, locks, sparse
files, or binary mutation/search.

The current platform sources of truth are Cloudflare's
[Durable Objects documentation](https://developers.cloudflare.com/durable-objects/),
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
and [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
