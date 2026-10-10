# Optional Git command

`@corca-ai/cf-vfs/shell/commands/git` exports `gitCommand`, backed by
isomorphic-git. The default command registry and root/shell barrels do not
import it. The Git engine is an **optional peer dependency**; consumers using
Git install it explicitly. Consumers using other commands do not need it.

```sh
npm install @corca-ai/cf-vfs isomorphic-git@^1.43.1
```

```ts
import { Shell } from "@corca-ai/cf-vfs/shell";
import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
import { gitCommand } from "@corca-ai/cf-vfs/shell/commands/git";

const shell = new Shell({
  fileSystem: vfs,
  commands: [...defaultShellCommands, gitCommand],
});
```

## Local repositories and remotes

All paths below are in the **same VFS namespace**, not the host operating
system's filesystem. A clone copies Git objects, references and committed
history, then checks out the selected branch; it does not copy uncommitted
working files, the source index, configuration, hooks or account information.
The entire object store is copied rather than hard-linked, including objects
not reachable from current branch tips. Packed objects and tags can
be transferred alongside loose objects. Network URLs and scp-style remotes
are refused; no HTTP client or network capability is used.

```sh
git init -b main /project
git -C /project config user.name Agent
git -C /project config user.email agent@example.invalid
printf 'hello\n' > /project/readme.txt
git -C /project add .
git -C /project commit -m initial

git clone --bare /project /remote.git
git clone /remote.git /copy
git -C /copy config user.name Agent
git -C /copy config user.email agent@example.invalid
printf 'updated\n' > /copy/readme.txt
git -C /copy add .
git -C /copy commit -m updated
git -C /copy push origin main

git -C /project remote add origin /remote.git
git -C /project fetch origin
git -C /project pull --ff-only origin main
```

Absolute/relative paths and `file:///absolute/path` URLs are supported. Stored
remote paths are resolved to absolute VFS paths. Bare repositories are useful
push targets: pushing to a non-bare repository's checked-out branch is refused.
Push only permits fast-forward branch updates, without force or deletion; the
reference is published with a VFS mutation-token guard. Fetch updates tracking
branches and imports tags; it leaves the working tree and local branches alone.
Pull permits fast-forward only and requires a clean tree and index, including
absence of untracked files. When the fetched branch already matches HEAD, pull
still checks cleanliness but leaves HEAD and the index unchanged and skips
checkout. No merge conflict resolution is provided.

## Supported command subset

| Command | Supported arguments |
| --- | --- |
| `init` | `[--bare] [-b BRANCH / --initial-branch BRANCH] [DIRECTORY]`; default branch `main` |
| `clone` | `[--bare] [--no-checkout] [-b BRANCH / --branch BRANCH] SOURCE [DIRECTORY]` |
| `add` | `[-A / --all] [PATH...]`; explicit paths required without `--all` |
| `status` | `[--short / -s / --porcelain]`; always emits short status |
| `diff` | `[--cached / --staged]`; unstaged or staged unified text differences; binary changes reported |
| `commit` | `-m MESSAGE / --message MESSAGE [--allow-empty]` |
| `log` | `[--oneline] [-n COUNT / --max-count COUNT] [REF]`; default count 10 |
| `branch` | `[NAME [START_REF]]`; lists or creates branches |
| `checkout` | `[-f / --force] REF` or `[-f / --force] -b NAME [START_REF]`; ordinary switching requires a clean tree/index |
| `config` | `[--local] [--get] KEY [VALUE]`; repository-local values only |
| `remote` | `[-v]` or `add NAME LOCAL_PATH` |
| `fetch` | `[REMOTE]`; defaults to `origin`; no pruning |
| `push` | `[-u / --set-upstream] [REMOTE [BRANCH / SOURCE:DESTINATION]]`; defaults to `origin` and current branch |
| `pull` | `[--ff-only] [REMOTE [BRANCH]]`; uses branch tracking configuration when omitted |
| `rev-parse` | `REF`; prints its object ID |

Global `-C DIRECTORY` can repeat without changing the calling shell's cwd.
`--` terminates option scanning. Other commands/options are errors, never
silently ignored. Diff covers content changes without rename detection or
mode-only patches. Status pathnames are always JSON-quoted. Commit prints the
full object ID. Output and exit statuses are a declared subset, not full native
Git CLI compatibility. Identity comes from local `user.name`/`user.email`,
overridden by `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`; committer environment
variables can override the committer. No host/global Git config is read.

## Boundaries and verification

Every access passes through the shell's scoped filesystem, preserving read/write
roots, credential checks, mutation limits, cancellation and I/O budgets.
Creation observes the session umask. Status/diff inspect actual file content so
same-sized edits within one second are visible despite the engine's coarse
stat cache. Shell operations preserve the underlying VFS inode/time semantics.
Read-only status does not refresh the Git index. Worktree body collection and
hashing share a 32-task limit per inspection; queued tasks release slots on
success or error. Metadata traversal remains concurrent. Blob staging starts with a
32-path batch. Small-body batches grow to at most 128 paths when their inspected
total stays within 1 MiB; larger bodies retain the 32-path bound. Removal-only
staging batches up to 1,024 paths without retaining file bodies.
Staging batches with at least 32 bodies can collect compressed loose objects
and persist them through the existing atomic `writeFiles` operation before
publishing the index. The adapter accounts for retained buffers and bounds the
set by shell and backend buffer headroom, leaving room for working-file reads.
Small sets, insufficient headroom and backends without capacity information use
ordinary individual writes. Any object-set failure remains fatal to that index
publication, including errors the engine normally retries. Object directory
creation is shared within the command; each actual write still checks traversal,
permissions, quotas and the session umask. Index serialization and compression
concurrency retain their existing bounds.
Selected-path staging prunes unrelated walker branches before stat or content
reads. New blobs with no HEAD/index entry skip comparison reads and hashes;
the engine reads and hashes them during staging with its normal permission and
CRLF handling. Files whose content and mode already match the index are left unchanged;
deletions share one index update per batch. The engine's index cache lasts only
for the current add command, never across shell executions. Inspection and
mutation share that cache. Missing ignore-file probes are shared only within
one read-only inspection phase; rule contents are not retained. Default 0644
writes preserve existing modes without a separate existence lookup, while
other creation modes retain the normal inspection path. Overlapping UTF-8
reads of this command's repository configuration share one pending read; no
completed configuration is cached. Every logical reader still consumes its I/O
allowance; fatal errors and cancellation retain the scoped adapter's handling.

Git operations are **not workspace transactions**. A failed/cancelled command
can leave partial objects, metadata or worktree changes. Hosts must serialize
Git commands with edits and other commands for the same repository; the applet
does not provide a distributed repository lock. Source repositories must remain
stable during local transfers. Read buffering is bounded by shell budgets, but
Git's retained buffers, pack assembly and decompression are not a hard bound on
engine memory. This is intended for bounded repositories, not arbitrary large
packs. Opaque/R2 bodies, shallow repositories, object alternates, submodules,
worktrees, hooks and LFS are outside this command's supported scope.

Node and workerd tests exercise local clone/push/fetch/pull, actual committed
bytes, dirty-tree and non-fast-forward rejection, quick edits, permissions,
binary bodies, links, modes and execution limits. Bundle source maps assert
both the applet and engine absent from every existing preset and present only
in the separate Git preset. Its bundle budget includes the engine.

The [production verification](../bench/git-command-verification-2026-10-08.json)
records the deployed build and an actual public-shell init/commit/local
clone/push/pull round trip. The demo explicitly opts in to this command.

The connected [coding and recovery evaluation](../bench/git-coding-evaluation-2026-10-09/report.md)
adds partial staging, mixed-size local clones, checkout byte verification, injected
write failures, mid-add cancellation and host-serialized callers to the public
benchmark. A failed add can retain completed staging batches; retry completes it.
A failed checkout can leave a partial worktree while preserving committed history.
The dirty-tree guard then rejects a plain retry. Explicit `git checkout --force REF`
(or `-f`) restores the selected committed tree and index, discarding conflicting
tracked edits and replacing untracked paths that obstruct checkout. Unrelated
untracked files are retained. It can also fail partway if storage or execution
limits are still exhausted; restore capacity before retrying. Ordinary checkout
continues to protect a dirty tree. `reset --hard` is not exposed. These probes do not simulate isolate crashes
or establish safety for uncoordinated concurrent repository writers.

The demo serializes whole shell source units, document open/edit/close and
scheduled document publications through one bounded queue per shared workspace.
This conservatively covers path aliases and both ends of clone/transfer without
trying to infer which repositories an arbitrary shell program can modify.
Signals and disconnections cancel queued or active work; ping and completion
remain responsive. Pending editor saves are attempted before and after commands.
A failed save keeps dirty text and reports an error; commands can still free
space so a subsequent save succeeds. Opening a document subscribes the reader,
and accepted edits acknowledge the author as well as other readers.

Diff skips identical stored object IDs before decoding blobs. Unstaged diff
hashes actual worktree bytes with at most 32 body comparisons active and reads
stored blobs only for changed paths, preserving same-size rapid edits. No stat
or content cache survives the command. The [recovery, coordination and diff
evaluation](../bench/git-recovery-coordination-2026-10-09/report.md) records tests,
local comparisons and production verification.

The [coding durability evaluation](../bench/coding-durability-2026-10-10/report.md)
adds actual Durable Object resets during checkout. Checkout gives the engine a
unique internal metadata pathname and translates it back at the scoped adapter;
this prevents an abandoned module-level index lock from blocking a new checkout
or another filesystem with the same visible path. No virtual directory is stored.
Hosts must still serialize repository operations: this is not a transaction or
a replacement for host coordination. Abrupt reset during other Git operations
has not been established safe by this experiment.

A demo editor version acknowledgment means the text was accepted into the open
document, not that it reached durable storage. Publication is deferred; failed
publication retains text only in the current object's memory. A restart before
successful publication loses that pending text. Completed VFS writes and
committed Git data are tested separately from this unsaved editor state.

Local clone, fetch and push reuse directory-entry metadata. A fresh local clone
also uses the existing recursive VFS copy when its object tree contains ordinary
inline files with default ownership, modes and no hard links, and the filesystem
explicitly reports that copying sees the same bytes as individual reads. Open
collaborative documents anywhere in that tree select individual reads and writes.
Fetch and push still merge objects individually, retaining existing objects.

Checkout groups eligible worktree writes into at most 32 files or 128 KiB.
Large files, insufficient buffer headroom, open collaborative documents and
implementations without the optional eligibility hint use individual writes.
Eligibility is checked again before publication. Each write promise resolves only
after its bytes commit; a failed batch leaves that batch unchanged, but earlier
batches can have committed. Use `checkout --force REF` to repair a partial checkout.
Permission checks, logical I/O and mutation budgets, cancellation, creation modes
and storage quotas still apply. Hosts must serialize repository operations,
document opens/closes and edits; the hint is not a lock or reservation.

The [safe bulk-operation evaluation](../bench/git-bulk-safe-2026-10-10/report.md)
records local measurements and failure tests. Actual Cloudflare batch interruption
and reset behavior has not yet been evaluated for this optimization.
