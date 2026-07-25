# Operations and security

## Isolation and routing

Route one tenant, workspace, or repository to one SQLite-backed Durable Object
using a stable name. That object is the strongly consistent namespace and
serialization boundary. Do not route all customers through one object: long
parses, scans, or SQL work on an object share its single-threaded execution
boundary.

Authorization belongs at the application boundary. Mode bits are metadata,
not access checks. For untrusted source, compose a deliberately small command
registry and set `ShellPolicy`:

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
the filesystem additionally skips the usage query that would feed `vfs.usage`,
so an unobserved workspace pays nothing. A throwing sink cannot change
behavior: its failure is discarded rather than rolling back a transaction,
altering an exit status, or masking the error the caller is about to receive.
And `vfs.usage` is reported only after its transaction commits, so a rolled-back
mutation never reports usage it did not apply.

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
key, error text, attempt count, and exponential next-attempt time. The alarm is
reset to the earliest open expiry, verification lease, retention deadline, or
retry. Operations are idempotent and survive object eviction.

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
