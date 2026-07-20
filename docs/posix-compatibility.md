# POSIX and Bash compatibility

`cf-vfs` borrows familiar pathname, status, utility, and shell behavior where
it maps cleanly to Workers. It is neither a POSIX ABI nor a full Bash
implementation: there are no operating-system processes, syscalls, TTYs, or
host filesystem access.

## Filesystem boundary

| Area | Version 2 behavior |
| --- | --- |
| Paths | `/`-separated canonical Unicode strings with `.`, `..`, repeated-separator, name-length, path-length, and trailing-slash validation. Shell-relative paths resolve from `cwd`. Paths are not arbitrary POSIX byte strings. |
| Regular files | Inline files contain arbitrary bytes and are limited to 8 MiB. Opaque files are immutable R2 generations whose metadata participates in the namespace but whose bodies are unavailable to shell commands. |
| Directories | Direct children, recursive traversal, atomic subtree move, recursive copy/remove, keyset pagination, and deterministic UTF-8 ordering are supported. A paginated traversal is mutation-tolerant, not snapshot-isolated. |
| Metadata | Kind, content class, byte size, mode-shaped bits, timestamps, revision, and mutation token are available. There are no inode, owner, group, link-count, access-time, or POSIX change-time guarantees. |
| Modes | A default `022`-like result (`0755` directories and `0644` files) and explicit mode updates are metadata only. They do not enforce access. |
| Concurrency | Whole-file publication and namespace changes are atomic within one DO. Revision and mutation-token guards reject stale work, including absent-path ABA. |
| Links and special files | Symbolic links, hard links, devices, sockets, FIFOs, sparse files, xattrs, and `mmap` are unsupported. |
| Locks and open handles | There is no persistent descriptor lifecycle or advisory/mandatory locking. Returned inline streams are bounded snapshots; guards provide optimistic concurrency. |
| Errors | Familiar codes include `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EFBIG`, `ENOSPC`, `EPIPE`, and `ENOTSUP`. `EREVISION` denotes a stale guard. This is not the complete POSIX errno set. |

Virtual descriptors `0`, `1`, and `2` exist only for one shell execution.
Pipelines connect them with byte streams and left-to-right `2>&1` duplication;
they are not Durable Object state and have no shared seek offset.

## Shell language

Bash Version 2 supports simple commands and assignments; quoting and escapes;
selected parameter, command, and arithmetic expansion; lists and pipelines;
groups, subshells, control structures, functions, and selected flow built-ins;
ordinary redirection, here-documents, here-strings, and pathname expansion. See
[Shell, commands, and direct API](commands.md) for the exact grammar and limits.

The parser rejects unsupported syntax before running any command. In
particular, process substitution, backticks, arrays, brace expansion, extended
tests, C-style `for`, background jobs, and arbitrary descriptors are not
approximated. The language version is exported as `BASH_COMPATIBILITY_VERSION`.

Version 3 source-file work is available while the complete Version 3 profile
is still in progress. `source` and `.` read only an explicit inline VFS path,
never search `PATH`, parse the complete sourced unit before executing it, and
share all relevant budgets with the caller. Opaque files remain unavailable.

Deliberate deterministic choices include:

- fixed `LC_ALL=C`, `TZ=UTC`, and whitespace `IFS` defaults;
- UTF-8 byte ordering rather than host locale collation;
- no-match globs remain literal, leading dots must be matched explicitly, and
  `**` has no special cross-directory meaning;
- pipeline stages receive cloned state, while a non-pipeline built-in can
  change the parent session;
- subshells and command substitutions also clone session state; command
  substitution output must be bounded valid UTF-8 and contain no NUL;
- arithmetic wraps deterministically at signed 64 bits instead of using the
  platform's native C integer width;
- ordinary groups, function bodies, and expanded unquoted here-documents use
  the current session; quoted delimiters produce literal bodies;
- `set -o pipefail` selects the rightmost real non-zero stage, while normal
  downstream early close maps upstream `EPIPE` to success;
- status 2 is syntax/usage, 126 is policy denial, and 127 is command-not-found.

Differential fixtures are pinned against `bash:5.3.3` with the same locale and
timezone. They cover representative supported quoting, assignment and
positional expansion, control, pipeline, redirection, glob, and status
behavior. Explicit rejection tests cover syntax deliberately outside Version
2. Neither suite implies compatibility outside the declared subset.

## Atomic redirection divergence

POSIX shells normally open and truncate `>` targets before the command runs.
`cf-vfs` buffers redirected output within the execution budget and publishes
the complete inline file only when that descriptor closes successfully. A
parse failure, later redirection-open failure, cancellation, deadline, output
overflow, or unexpected runtime failure leaves the old target intact. A
normally completed command can still commit output when its status is nonzero.

This divergence is intentional: it prevents a bounded cloud execution from
leaving a misleading truncated or partial file. Append redirection similarly
publishes one bounded append at close. Opaque append is unsupported; `>` may
replace an opaque entry with inline bytes and durably queue the old generation.

## Utility names

Utilities implement the options documented by this project, not an implicit
GNU, BSD, or POSIX superset. Unknown options are usage errors. Text-oriented
operations use fatal UTF-8 decoding; byte-oriented operations preserve bytes.
Applications should test against the exported command contract rather than
assuming behavior from a same-named host binary.
