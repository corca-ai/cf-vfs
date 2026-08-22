# Operations and security

## Isolation and routing

Route one tenant, workspace, or repository to one SQLite-backed Durable Object
using a stable name. That object is the strongly consistent namespace and
serialization boundary. Do not route all customers through one object: long
parses, scans, or SQL work on an object share its single-threaded execution
boundary.

Authorization begins at the application boundary. For untrusted source,
compose a deliberately small command registry and set `ShellPolicy`:

```ts
const shell = new Shell({
  fileSystem,
  commands: [catCommand, grepCommand, findCommand],
  policy: {
    readRoots: ["/input"],
    writeRoots: ["/output"],
    allowedCommands: ["cat", "grep", "find"],
    maxMutations: 100,
  },
});
```

`allowedCommands` names canonical applets, and the entry `sh` is a capability
rather than a reference to an applet: it authorizes running *any* executable
file inside the readable roots, whether or not an `sh` applet is registered.
Omit it — as the example above does — when a workload should never run stored
source. The commands a script invokes are still checked against the same list,
so the reachable surface is the readable roots intersected with the allowlist.

The shell receives a capability-wrapped `ShellFileSystem`; it has no opaque
upload, lease, GC, or R2 body method. Treat scripts, positional arguments,
environment variables, and uploaded bytes as separate inputs. Put dynamic
values in positional arguments instead of interpolating source.

### POSIX execution identity

The raw `VirtualFileSystem` remains a trusted administration capability. It
does not apply discretionary-access checks, which lets a host provision and
repair a workspace. Bind an immutable user view with
`fileSystem.forCredentials(credentials, { umask })`, or supply the same
numeric identity to one shell execution:

```ts
await shell.executeText({
  script,
  cwd: "/workspace",
  credentials: {
    uid: currentUser.id,
    gid: currentUser.primaryGroupId,
    supplementaryGids: currentUser.groupIds,
  },
  umask: 0o027,
});
```

This activates Linux-style owner/group/other selection, search permission on
ancestor directories, read/write checks, parent-directory checks for namespace
changes, owner-only `chmod`, restricted `chown`, setgid-directory inheritance,
and sticky-directory deletion rules. New entries receive the execution uid and
effective directory group after `umask`. Uid 0 bypasses DAC but never bypasses
`ShellPolicy`; the effective permission is the intersection of both.

Numeric IDs remain the authorization source. A host that owns an account
directory may separately attach a bulk resolver:

```ts
const shell = new Shell({
  fileSystem,
  commands,
  identityResolver: {
    resolveIds: (request, signal) => accounts.namesForIds(request, { signal }),
    resolveNames: (request, signal) => accounts.idsForNames(request, { signal }),
  },
});
```

The resolver may return partial maps. `ls -l`, `stat %U/%G`, `id`, and `groups`
fall back to numeric IDs for missing display names; numeric-only forms do not
call it. Named `chown` fails when its mapping is missing. Resolution is
deduplicated, bulk-called, and cached only for one execution, including misses,
so account renames are visible to the next execution and no unbounded
shell-global cache exists. `ShellDurableObjectOptions.identityResolver` accepts
a filesystem-aware factory inside the object; no resolver function or account
directory crosses RPC. Account names are bounded to 255 UTF-8 bytes and may not
contain whitespace/separator, control, colon, or slash characters, preventing a
resolver response from injecting extra output fields or lines.

Only uid 0 may change an owner; an ordinary owner may change the group only to
its primary or supplementary groups. Resolver output does not grant either
permission. Setuid execution, POSIX capabilities, ACLs, and user namespaces are
outside this profile.

Never derive credentials from `USER`, `HOME`, or another environment variable:
the script can change them. For an RPC method, authenticate the caller in the
application and construct `credentials` there. `ShellDurableObject` validates
the transport shape but does not authenticate an arbitrary identity a remote
caller puts in that field.

### Credentials stay outside the shell

Anything the shell cannot reach on its own arrives as a host-supplied
capability: a small structural interface the host implements and a command only
calls. The host keeps the binding, the credential, and the decision; the shell
gets a function. There are three — `ShellContentReader`, where the host holds the
bucket and the shell holds `open(path)`, and `ShellNetwork`, where the host
holds whatever authorizes a request and the shell holds `fetch(request)`, plus
`ShellIdentityResolver`, where the host retains the account directory and the
shell receives bulk ID/name mapping methods.

That seam is what keeps a secret out of the environment a script can read. A
host authorizing a capability attaches, scopes, or signs the credential inside
its own implementation, so nothing carrying it is ever in `env`, in the
arguments, or on the filesystem — and `env`, `set`, and a readable `/proc`-style
path cannot print what was never put there. Passing the same credential as an
environment variable would also work, and is the thing to avoid: `ShellPolicy`
bounds which paths and which commands, not what a command does with a variable
it is allowed to read.

Two limits are worth stating rather than discovering. A capability bounds what
a session can ask for, not what comes back: a call the host authorizes can
still return a secret in its response, and that response is ordinary bytes once
it is in the shell. And a capability is not a policy — authorize it on the host
*and* gate it per session, the way `opaqueContent` does, so that adding it to a
host is not a decision about every session running there.

## Execution budgets

Every execution owns one shared budget across all pipeline stages. Defaults:

| Limit | Default |
| --- | ---: |
| one submitted or sourced unit / cumulative source bytes | 1 MiB / 4 MiB |
| AST nodes / nesting depth | 10,000 / 64 |
| commands / steps / loop iterations | 10,000 / 100,000 / 10,000 |
| function depth / source depth / script depth | 64 / 16 / 8 |
| one command-substitution output | 1 MiB |
| expansion work / produced characters / produced fields | 10,000,000 / 1 MiB / 10,000 |
| pipeline bytes | 8 MiB |
| stdout / stderr | 8 MiB each |
| materialized stdout + stderr | 8 MiB |
| total I/O | 32 MiB |
| simultaneously buffered semantic data | 16 MiB |
| one decoded line / buffered records | 1 MiB / 100,000 |
| glob matches / mutations | 10,000 / 10,000 |
| deadline / no-output-consumer timeout | 30 s / 5 s |

Lower these per workload. A policy mutation limit can only tighten the runtime
limit. Script depth is counted separately from source depth, so a script that
sources a file that runs a script is bounded by both. Glob scans, traversal, decoded records, and output all charge their
specific limit as well as relevant shared work/I/O limits.

Nested scripts, sourced units, pipelines, functions, loops, and command
substitutions consume the same execution budget. Sourced units additionally
share cumulative source-byte and AST-node allowances. Command substitutions
also charge total I/O and their dedicated output limit; neither construct
creates a fresh allowance.

Parameter-pattern expansion uses a dynamic-programming matcher rather than a
regular expression. Candidate matching, removal, and replacement charge the
shared expansion-work counter. Every completed word expansion charges its
materialized character and field counts, including values later subject to
field splitting or pathname expansion. The limits are cumulative across child
shell scopes and fail before returning a truncated expansion. A scalar pattern
operand is also capped by the absolute character limit before it is copied into
the matcher's code-point representation.

Nounset performs constant-time environment membership checks at expansion
sites and does not create a separate allowance. Arithmetic recursion and lazy
parameter words continue to use the existing bounded AST and shared execution
budget. Isolated scopes clone the option flag but never clone or reset any
budget; nounset termination settles their active descriptors through the same
pipeline, substitution, and atomic-redirection cleanup paths. A redirection
owned by a scope terminated for nounset is aborted rather than publishing its
partial buffered output, including when a parent later observes an isolated
scope's status.

Errexit adds no allowance and never resets a shared budget. Its suppression is
an explicit AST evaluation context passed through lists, pipelines, compound
commands, functions, and sourced units. A triggering ordinary status requests
shell flow only after the command's stdout/stderr settle; enclosing descriptor
owners then close normally before the flow leaves them. Root completion and RPC
therefore preserve the exact status and all backpressure. Multi-stage
pipelines settle every stage and edge before `pipefail` selects a status.
Cancellation, deadline, idle timeout, output or
buffer overflow, nounset, and unexpected invariants continue through their
existing abort paths instead of being converted into catchable errexit flow.
Internal evaluation results also carry whether a non-zero status came from a
suppressed position. Non-subshell compounds preserve that provenance, while a
function, source, subshell, or multi-stage pipeline boundary deliberately
re-exposes its returned status for the caller's errexit decision.

Double-bracket boolean, grouping, and predicate nodes consume the shared AST,
nesting, step, and expansion budgets. Operand expansion is scalar, so it never
starts a pathname scan. Equality patterns reuse the dynamic-programming scalar
matcher and its transition accounting. Lexical and strict-decimal comparisons
charge operand length before bounded linear work. Metadata predicates perform
only policy-checked namespace `stat` calls; an opaque regular file never causes
an R2 body read.

The execution deadline starts before complete-unit parsing. In one linear scan,
the lexer builds sparse UTF-8 byte-offset checkpoints per unit instead of
re-encoding every source prefix at each token, and checks the shared deadline
while building them. Sourced units use the same execution deadline and
cumulative parser budgets.

The deadline is the one limit in this table that depends on a wall clock, and
on Workers a wall clock is not what it appears to be. Production Workers freeze
`Date.now()` between I/O events, so an execution that performs no I/O — a
script working only against SQLite-backed inline files, for example — can run
without ever observing elapsed time. Every synchronous deadline check inside
such an execution then passes regardless of how long it has actually taken.

Two mechanisms carry the guarantee instead. A `setTimeout` armed for the
remaining deadline aborts the execution on real elapsed time, independently of
what `Date.now()` reports; it needs the execution to reach a suspension point,
which ordinary command, pipeline, and stream work provides. Underneath that,
the count-based limits — steps, commands, loop iterations, AST nodes, nesting
depth, expansion work, glob matches, and every byte budget — bound the work a
single unit can do with no reference to time at all. They, not the deadline,
are what makes an uninterrupted synchronous stretch finite.

Treat the deadline as a bound on wall-clock latency, not as the primitive that
makes execution finite. Supply `now` in `ShellOptions` when the application has
a clock it trusts more, and lower the count-based limits when a workload needs
a tighter guarantee than a timer can express. Local workerd does not reproduce
the production freeze, so tests cannot detect a dependence on it.

`read -r` consumes fd 0 with a fatal streaming UTF-8 decoder. It retains at
most the unread suffix of one upstream chunk plus one decoded line under the
shared buffered-byte budget, applies the one-line and total-I/O limits, and
cancels promptly with the execution. The root input is also cancelled when the
execution finishes, releasing an unread suffix and its producer. This preserves
the next record without draining the rest of a backpressured stream. Repeated
`getopts` calls and all three positional built-ins consume the ordinary command
and step budgets rather than creating a separate loop budget.

`executeStream()` exposes real backpressure. Consume stdout and stderr
concurrently; if a root output remains blocked beyond the idle timeout the
execution fails instead of retaining memory forever. Cancellation wakes
blocked writers and readers. Limit, deadline, and cancellation failures error
affected streams and resolve `completed` with status 1; they never return a
valid truncated prefix. Unexpected command or runtime invariant failures
reject `completed`.

`executeText()` is intentionally bounded materialization. It drains both
outputs concurrently and returns decoded strings. `executeBytes()` returns
bytes without duplicating them as strings. Prefer
`executeStream()` in-process or `executeTo()` across RPC when the consumer can
stream.

## Interactive sessions and reconnect

The demo protocol's `hello` message is machine-readable so an agent or a UI can
discover what a session supports without sniffing versions: a protocol number,
a feature list, the caps it actually enforces — the message size that rejects a
frame, the source size that ends a unit, and the candidate count — and, the
part that matters most, what survives a disconnect.

Files are in the Durable Object and durable. The shell session is not: working
directory, environment, shell functions, and history live in memory for as long
as the socket does. A reconnect produces a new session, and a client must not
present it as a resumed one. The `durability` field says exactly this
(`files: "durable"`, `session: "connection"`), and the demo client prints it on
connect rather than leaving a user to discover it by losing a `cd`.

Terminal dimensions are forwarded as a presentation hint and published as
`COLUMNS` and `LINES`, because a variable is the only form a script can read
one in. Nothing else is implied: there is no terminal behind the session, no
modes, no `ioctl`, and no job control.

Line editing is the client's. Ctrl-W, Ctrl-U, Ctrl-K, Ctrl-L, and
reverse-history-search never reach the server, because the shell reads lines
and not keystrokes. Ctrl-C is the exception and keeps its meaning: it cancels
the running execution, or clears a partly typed line when nothing is running.
Ctrl-D on an empty line ends the session. Completion is the one editing feature
that needs the server. It is triggered by Tab rather than by typing, so there
is no per-keystroke request to debounce, and each request carries the client's
edit generation — any keystroke between asking and answering invalidates the
offsets in the reply, and the client drops it rather than splicing it into a
line that has moved on.

## Observability

`VirtualFileSystem` and `Shell` each accept an optional `onEvent` sink.
`ShellDurableObject` exposes one hook for both:

```ts
export class WorkspaceFiles extends ShellDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      commands: defaultShellCommands,
      onEvent: (event) => console.log(JSON.stringify({ workspace: ctx.id.toString(), ...event })),
    });
  }
}
```

| Event | Emitted when | Carries |
| --- | --- | --- |
| `vfs.quota` | a storage limit refused work | `limit`, `used`, `max`, optional `requested`/`path` |
| `vfs.usage` | a mutation committed | `inlineBytes`, `entries` |
| `vfs.mutation` | a namespace change committed | `op`, `path`, optional `mutationToken`/`subtree` |
| `vfs.opaque-upload` | a session reached `begin`, `commit`, `abort`, `expire`, or `reject` | `uploadId`, `objectKey`, `path`, optional `reason` |
| `vfs.garbage` | a GC batch settled | `deleted`, `remaining`, `failed` |
| `shell.limit` | an execution limit refused work | `limit`, `used`, `max` |
| `shell.command` | a utility or function finished | `name`, `exitCode` |
| `shell.execution` | a submitted unit finished | `exitCode`, `durationMs`, optional `failureCode` |

`shell.limit` covers every limit `ExecutionBudget` owns — steps, commands, loop
iterations, total I/O, mutations, glob matches, expansion work, expansion
characters and fields, buffered bytes, and the deadline — plus the output idle
timeout. Limits enforced by the parser and the output pipes do not emit a
per-limit event; they surface through `shell.execution.failureCode` instead.

Three properties are contractual. The sink is never invoked when omitted, and
the filesystem additionally skips the usage query that would feed `vfs.usage`
and builds no `vfs.mutation` object at all, so an unobserved workspace pays
nothing. A throwing sink cannot change
behavior: its failure is discarded rather than rolling back a transaction,
altering an exit status, or masking the error the caller is about to receive.
And `vfs.usage` and `vfs.mutation` are reported only after their transaction
commits, so a rolled-back mutation never reports usage or a change it did not
apply.

### Watching the namespace

`vfs.mutation` is for a host that maintains a view of the workspace — a file
tree, an open document, a search index — and needs to know when what it is
showing stopped being true.

It names the change (`create`, `write`, `remove`, `move`, `metadata`) and the
path, and carries the `mutationToken` now in force. That token is also how a
writer recognizes its own publication: `writeFile` returns the same value, so
a host that remembers what it wrote filters its own echo without the event
needing any notion of who wrote. There is deliberately no revision, size, or
writer identity — none of them changed what a consumer did with the event, and
the first two are not known where the token is published, so carrying them
would cost a query this event does not otherwise need.

Two shapes matter for a consumer. A single-path change carries `path` and a
token. A set-based change — recursive `remove`, `move`, recursive `copy` —
carries `subtree` with the `root` it covered and, for a move, the `to` it
moved to, and **no token**. Those operations never materialize their entries,
which is what makes them cost a constant number of statements; reporting one
event per entry would give that back. Because a move is a prefix rename, a
consumer holding `/src/file` under a move of `/src` to `/lib` recomputes
`/lib/file` from `root` and `to` alone.

One call can report several changes. Creating parents publishes each directory
it had to make, because each is a change a view has to reflect. Treat the
notification as one change per event, not one event per call.

The events are volatile: a consumer that was not connected did not receive
them. For that case, enable the change cursor below.

### Catching up after a disconnect

`recordChanges` stamps every path change with a workspace sequence, and
`changesSince(cursor)` reports what changed after it:

```ts
const { changes, cursor, more } = workspace.changesSince(lastSeen, { limit: 500 });
for (const change of changes) {
  if (change.present) refetch(change.path);
  else drop(change.path);
}
```

It is off by default. A workspace that never enables it stamps nothing, and
because the index is partial — `WHERE change_seq > 0` — it carries no index
entries either. Enabled, the sequence rides the same UPSERT that already
publishes the token and the counter is held in memory, so recording adds a
bound parameter rather than a statement: the metered mutation paths cost the
same either way.

**Take a cursor before reading, not after.** `changesSince(0)` reports what
changed after recording was enabled, not the whole namespace — paths that
predate it are not invented. A consumer with no state should read the cursor
first, then walk the namespace; anything that changes during the walk carries a
later sequence and is replayed on the next call. Reading first and taking a
cursor after loses whatever happened in between.

The feed is collapsed: one entry per path however many times it changed,
holding what is true now. That is what a consumer rebuilding a view wants, and
it is why the history costs one column on rows that already exist rather than a
row per change. It also means the feed cannot be replayed as a sequence of
operations — it says where things ended up.

**A rename arrives as an absent path and a present one, with nothing pairing
them.** The live `vfs.mutation` event expresses a move; a collapsed feed
structurally cannot. A consumer that must follow an open document across a
rename it did not observe has to record moves itself while it is connected —
every move reaches it as an event, and its own table can hold them. Without
that, a reconnecting client closes the old path and opens the new one, which
loses the association but not the content.

Pages are bounded (1,000 by default, 10,000 maximum). Continue while `more` is
set, resuming from the returned `cursor`; the cursor stands still rather than
rewinding when nothing changed. `changesSince` is not available on a
credential-bound view: the feed reports paths without regard to what a user can
see, so it stays with the trusted capability.

### Editing one file from several places

`@corca-ai/cf-vfs/collab` is the layer between a workspace and an editing
session. It is not core, it is not imported by anything else, and it is
asserted absent from every bundle preset — a consumer that does not edit
collaboratively carries none of it.

It supplies three things and deliberately not a fourth:

- `DocumentRegistry` — which paths are open, the token each was read at, and
  whether it holds text the namespace has not been given. It also follows the
  namespace: `observe(event)` takes a `vfs.mutation` and rebinds open paths
  through a move or closes what a removal took.
- `CollaborativeFileSystem` — a `VirtualFileSystem` that routes reads and
  writes of open documents through them. Pass it to `Shell` in place of the
  raw filesystem.
- `textEdits(before, after)` — the change one text represents against another,
  derived from the diff already in `src/core`.

The fourth is a merging document itself. `CollaborativeDocument` is an
interface the host implements, because the choice has real consequences for a
Worker — Yjs is JavaScript while Loro and Automerge are Wasm — and it belongs
to the application.

Two behaviors are the point of the whole layer:

**A write to an open document becomes an edit.** Without it, `sed -i` on a file
someone is typing into is a guarded whole-file publication: it wins and
discards their work, or it loses with `EREVISION`. Routed through the document
it merges, and everyone else sees an ordinary remote change.

**A read of an open document sees what has not been published.** Flushing
before an execution does not cover this on its own, because a write *during*
the execution leaves the document ahead of storage — `sed -i` followed by `cat`
in one script is enough to show it.

Publication stays the host's to schedule. `publishDocument()` writes the
document guarded by the token it was read at and with `skipIfUnchanged`, so a
timer-driven flush neither overwrites a change it did not see nor churns the
revision when nothing moved. `EREVISION` is the signal to call
`reconcileDocument()` and try again. Nothing here starts a timer or holds a
socket; both are the application's.

`textEdits` is line-granular, because it reuses the repository's diff rather
than adding a second one. An edit inside a line replaces the line, which costs
a little concurrency on the same line and none on different lines.

### Durability of an acknowledged change

A write is durable when its call resolves — the transaction has committed and
Cloudflare's output gate holds outbound messages until it has.

An application layered on top may acknowledge earlier than that. A collaborative
editor that accepts an edit into memory and publishes it to the filesystem on a
timer has acknowledged something the filesystem has not yet been told about, and
an eviction between the two loses it. That is the application's contract to
state, not this library's, and it is worth stating explicitly to whoever builds
on it: say what a client may assume when its edit is accepted, and how much can
be lost between flushes. `vfs.mutation` fires only after the commit, so it is a
sound signal for "this is now durable" and an unsound one for "this was
accepted".

`shell.command` is one event per command; sample or filter it under load.
Cloudflare bills SQLite rows read/written and stored data, so pair these events
with platform analytics for deployed workloads.

## Errors and the RPC boundary

Every failure this package raises is a `VfsError` carrying a `code` from
`VFS_ERROR_CODES` and, where a path is meaningful, a normalized `path`.
Discriminate with the exported `isVfsError()` rather than `instanceof`:

```ts
import { isVfsError } from "@corca-ai/cf-vfs";

try {
  await workspace.stat(path);
} catch (error) {
  if (isVfsError(error) && error.code === "ENOENT") return null;
  throw error;
}
```

Workers RPC rebuilds a thrown error at the caller as a plain `Error`. The own
properties — `name`, `code`, `path`, `message` — survive, but the prototype does
not, so `error instanceof VfsError` is `false` for every failure observed
through a `VfsDurableObject` or `ShellDurableObject` stub. `isVfsError()` matches
the tagged name and a recognized code, so it holds on both sides of that
boundary; a bare `Error`, a plain object, and an unrecognized code are all
rejected. Never branch on `error.message`: message text is not a contract.

A non-zero shell exit status is not an error. `executeText()`, `executeBytes()`,
and `executeTo()` resolve with the status; they reject only for a limit,
deadline, cancellation, invalid RPC argument, or runtime invariant failure.

## Inline storage controls

Inline bodies are arbitrary bytes with an absolute 8 MiB per-file ceiling.
Configure lower per-file limits, workspace logical-byte quota, entry quota,
instance-wide in-flight buffered bytes, maximum database bytes, and reserved
database headroom. The default SQLite chunk is 256 KiB and the Durable Object
backend accepts at most 1 MiB per chunk, below Cloudflare's 2 MB BLOB/row
limit. The default logical inline quota is 512 MiB, entry quota is 100,000, and
in-flight materialization quota is 32 MiB.

A read snapshot holds in-flight capacity until its stream completes or is
cancelled. Streaming writes collect into fixed slabs, recheck the path token,
then publish in one short transaction. Failed collection or a stale guard does
not mutate the file. `SQLITE_FULL` and proactive headroom exhaustion surface as
`ENOSPC`; reads and cleanup remain available.

The quotas are constructor options, and a workspace can be made as small as it
needs to be:

```ts
new VfsDurableObject(ctx, env, {
  maxInlineFileBytes: 16 * 1024,      // one file
  maxInlineLogicalBytes: 50 * 1024,   // everything in the workspace
  maxEntries: 256,                    // files, directories, and links
});
```

A write that would cross one of these fails with `ENOSPC` naming the path and
the quota, changes nothing, and leaves what is already there readable — so a
caller that hits a ceiling can delete something and continue rather than
needing a new workspace. The public demo runs at the numbers above.

Monitor logical inline bytes, entries, `storage.sql.databaseSize`, quota
failures, stream-limit failures, deadline/idle cancellations, and per-command
status. The `onEvent` hook above reports all of these except `databaseSize`,
which the application reads directly.

## Opaque upload trust boundary

Large bodies must travel from a trusted gateway or direct Worker binding to
R2, not through the metadata DO:

1. reserve with `beginOpaqueUpload()`;
2. upload once to the returned random generation key;
3. commit by upload ID; the coordinator performs R2 `HEAD` outside SQL and
   trusts only store-observed size, ETag, version, and verified digest;
4. abort on client failure, or let the persisted expiry/alarm recover it.

Do not let a client choose an existing key or assert an unverified SHA-256.
For multipart upload, the trusted gateway must complete parts under the
reserved generation and only then ask the coordinator to commit. A key is
immutable after its conditional create. Direct R2 bindings are trusted: never
hand one to an untrusted client. A gateway must bind upload authority to the
reservation key and expire it no later than the session expiry.

| Persisted state | Recovery behavior |
| --- | --- |
| `open` | commit may claim it; expiry converts it to GC work |
| `verifying` | concurrent commit gets `EAGAIN`; an expired verification lease becomes GC work |
| `committed` | retry returns the receipt during its 24-hour retention window; abort is a no-op |
| `garbage` | commit is rejected; deletion waits for authority expiry plus a settlement grace, then retries idempotently |

The namespace mutation token and verification lease token are checked after
`HEAD`, closing ordinary races, absent-path ABA, and stale-verifier cleanup.
Copy and move manipulate SQLite references only.
Removing/replacing the last live reference queues deletion transactionally.

## Reads, leases, and garbage collection

`resolveOpaqueRead()` persists a bounded retention lease before returning R2
metadata. The gateway must start `getStream()` within that lease. Removing the
path during the lease hides the name immediately but delays object deletion.
The default lease is five minutes and the maximum is one hour.

`ShellDurableObject.alarm()` drains bounded GC batches. Failures retain the
key, error text, attempt count, and exponential next-attempt time. Maintenance
is due at the earliest open expiry, verification lease, retention deadline, or
retry. Operations are idempotent and survive object eviction.

A Durable Object has one alarm, and composing this filesystem inside a host
class that owns `alarm()` shares it. There is no way to ask whether the alarm
currently set belongs to the filesystem, so scheduling is earliest-wins in both
directions: an alarm already set is never moved later, and no alarm is ever
deleted. A host timer is therefore never stopped or delayed by maintenance. The
cost is one spurious wake-up when maintenance work disappears while its alarm is
still pending — the alarm fires, finds nothing due, and re-arms to whatever is
next.

The consequence for a composing host is that **its `alarm()` must run
maintenance**, as `VfsDurableObject.alarm()` does and the README's example
shows. When a host's alarm is the earlier one, deferring to it means the
filesystem's own time is not armed until something re-arms it, and every exit
from `drainGarbage()` is what does. A host that owns `alarm()` and never calls
`drainGarbage()` leaves expiry, lease, and retry work waiting for the next
mutation that schedules.

Alert on old `open`/`verifying` sessions, growing GC depth, repeated delete
attempts, R2 `HEAD` mismatch/missing objects, and database headroom. The
`vfs.opaque-upload` and `vfs.garbage` events carry each of these: an `expire`
or `reject` phase names the failure in `reason`, and `vfs.garbage.remaining` is
the live queue depth. An opaque
namespace entry whose R2 body is missing is `EIO`; repair or remove it rather
than silently treating it as empty.

Platform behavior and limits change. Verify deployments against Cloudflare's
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/), and [R2
pricing](https://developers.cloudflare.com/r2/pricing/).
