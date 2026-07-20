# POSIX-style compatibility

`cf-vfs` adopts the path and namespace model of a POSIX-style filesystem, but
it is not a POSIX compatibility layer. It does not implement the POSIX
system-call ABI, mount into an operating system, or run applications written
against file descriptors without adaptation.

The intended compatibility is conceptual: applications can organize durable
state as files and directories and use familiar path-oriented operations
instead of directly coordinating SQLite rows and R2 object keys.

## Compatibility profile

| Area | Status | `cf-vfs` semantics |
| --- | --- | --- |
| Rooted namespace | Supported | Each logical filesystem is a tree rooted at `/`. One Durable Object normally owns one workspace, repository, or tenant. |
| Paths | Partial | Absolute and `cwd`-relative paths, `/`, `.`, and `..` are normalized. A trailing slash requires a directory. Paths are JavaScript strings subject to UTF-8 name and path limits, not arbitrary POSIX byte strings. |
| Directories | Supported | Directories have direct children and support creation, listing, recursive discovery, atomic subtree moves, and removal. |
| Regular files | Partial | Mutable files contain valid UTF-8 text. Binary files are immutable R2 objects and have a separate read/write API. |
| Metadata | Partial | Kind, content kind, logical byte and line counts, mode, creation/modification times, and revision are available. There are no inode, link-count, owner, group, access-time, or POSIX change-time guarantees. |
| Mode bits | Metadata only | File-type and permission-shaped mode bits are retained for display and interoperability. They are not access-control enforcement. |
| Errors | Partial | Filesystem failures use familiar codes such as `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `ENAMETOOLONG`, `EFBIG`, and `ENOTSUP`, plus library-specific errors such as `EREVISION` and `ENOTTEXT`. `E2BIG` is retained for bounded command/search inputs and this is not the complete POSIX errno set. |
| Atomicity | Supported within its boundary | Text replacement, namespace changes, and related SQLite metadata changes are transactional within one Durable Object. A revision guard can reject stale text changes. |
| Cross-storage changes | Recoverable, not atomic | SQLite and R2 do not share a transaction. Immutable generation keys and a durable garbage-collection queue make binary create/remove operations recoverable. |
| Links | Unsupported | There are no symbolic or hard links, link traversal, inode identity, or link counts. |
| File descriptors | Unsupported | There is no `open`/`read`/`write`/`close` descriptor lifecycle, shared offset, descriptor inheritance, or `mmap`. |
| Permissions | Unsupported | There are no users, groups, ownership checks, ACLs, or capability checks derived from mode bits. Authorization belongs to the application. |
| Locks | Unsupported | There are no advisory or mandatory file locks. Revision guards provide optimistic concurrency for dependent text updates. |
| Special files | Unsupported | Devices, FIFOs, Unix sockets, sparse files, and extended attributes are outside the model. |
| Unix-style commands | Partial | Structured commands expose selected namespace, comparison, patching, hashing, and bounded text-transform behavior. They do not parse shell strings or promise complete POSIX/GNU/BSD flag compatibility. |

Commands that transform text can consume an explicitly bounded `stdin` string.
This is a data field, not a process stream: callers connect command results
themselves and the executor never interprets shell pipeline or redirection
syntax.

Directory and recursive iteration also have paginated APIs. Their keyset
cursors are an application-level scaling facility rather than POSIX directory
descriptors, and they do not retain a snapshot across calls.

## Why the boundary exists

Cloudflare Workers do not provide a persistent local filesystem. Durable Object
SQLite provides a private, strongly consistent coordination and storage
boundary for one logical namespace, while R2 is suitable for larger immutable
binary bodies. `cf-vfs` maps the filesystem concepts that fit those primitives
without hiding their important constraints.

Several omissions preserve those properties:

- Path-indexed entries make direct-child and subtree queries predictable;
  symbolic and hard links would require a different identity and traversal
  model.
- Whole-file UTF-8 text changes can be transactional in SQLite; arbitrary
  binary mutation would weaken the simple immutable R2 lifecycle.
- Avoiding open descriptors and locks keeps durable state independent of a
  particular Worker isolate or RPC session.
- Structured commands retain familiar operations without adding a shell,
  process model, quoting ambiguity, or command injection surface.

## Behavioral expectations

Consumers should rely on the documented TypeScript contracts rather than
assuming behavior from a similarly named POSIX function or Unix utility. For
example, destination replacement for move is opt-in, binary files cannot be
overwritten in place, and command inputs are objects rather than command-line
arguments.

Commands can use familiar exit-status conventions without a process model.
For example, `test` returns status 1 for a false predicate, `grep` returns 1 for
no matches, and `cmp`/`diff` return status 1 for different files, while their
structured result explains the outcome. This is distinct from a filesystem or
validation error.

New features should prefer familiar path-based filesystem semantics when they
fit the Durable Object and R2 model. They should not claim POSIX compatibility
unless the corresponding behavior is deliberately specified and tested.
