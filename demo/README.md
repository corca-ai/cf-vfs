# Deployed terminal demo

The browser terminal at `https://vfs.borca.ai/` is part of the separately
deployed benchmark Worker, not the npm package.

- `demo/workspace.ts` implements the WebSocket protocol and one SQLite-backed
  `DemoWorkspace` Durable Object per browser workspace ID.
- `demo/public/` contains the static terminal UI.
- `wrangler.benchmark.jsonc` binds the demo assets and Durable Object while
  retaining the existing `VfsBenchmark` Durable Object and `/benchmark`
  endpoint.

The demo directory is outside `src`, outside `tsconfig.build.json`, and outside
the package `files` allowlist. Deploying or changing the demo therefore does
not add code to the published library.

`demo/document.ts` adds the editing pane: one `DocumentRegistry` per room, a
`CollaborativeFileSystem` the shells run against, and a debounced write-back.
A `sed -i` typed in the terminal lands in an open editor as an edit rather
than overwriting what someone is typing, and a `mv` or `rm` moves or closes
the pane instead of leaving it pointed at a path that no longer names
anything.

The document is a string, not a CRDT. Every change to a room — a keystroke on
a socket, a shell command — runs on one single-threaded Durable Object, so
there is no concurrent application for a CRDT to reconcile. A client that
applied its own edits before the server confirmed them is the one that would
need Yjs, and `CollaborativeDocument` is an interface so that host can supply
it. A version stamp catches a client whose text crossed with someone else'''s,
which is the same shape the filesystem'''s mutation token has one layer down.

Each open WebSocket owns an in-memory `InteractiveShell`; its cwd, variables,
functions, and options live for that connection. The browser sends a bounded
keepalive while the tab is open. Files live in the Durable Object's SQLite
storage and survive reconnects, Worker isolate eviction, and page reloads.

The shell executes as numeric account `1000:1000`; `demo/identity.ts` is the
host-owned account directory that resolves those IDs as `demo:demo`. Existing
rooms created before credential-bound execution transfer their persisted tree
to that account once, so enabling DAC does not strand shared files.

Local development:

```sh
npm run typegen:benchmark
npx wrangler dev --config wrangler.benchmark.jsonc
```

Production deployment:

```sh
npm run deploy:public
```

## Public file and Git benchmarks

`/benchmarks/` is linked from the shell demo. It reads saved results on load;
only an explicit POST to `/api/benchmarks` requests a run. The existing private
`/benchmark` endpoint retains its bearer authentication.

`PublicBenchmarks` owns an isolated VFS. `/benchmarks/latest.json` contains the
last successful result, and its VFS `modifiedAtMs` controls freshness: requests
before `mtime + 600_000` reuse it; at or after that boundary a request can claim
a new run. `GET` never claims one. The shared deterministic object name bounds
this public workload to one coordinator, separate from terminal workspaces.

A VFS run record coalesces concurrent requests. A VFS checkpoint records each
completed workload group, and Durable Object alarms execute the next group.
The browser gets 202 promptly and polls read-only status, so closing a tab does
not cancel the run. Owner restart can recover a persisted job; a group that
was interrupted restarts from its fixture setup, and only a fully checked
result is published. Checkpoints renew a five-minute lease. A stale runner
cannot checkpoint, publish, or delete a newer run's scratch tree. Failures keep
the previous successful result and permit another explicit request when that
result is eligible; there is no automatic periodic benchmark.

`BenchmarkRunner` is a named Worker entrypoint bound to this same Worker via a
service binding. It measures each DO RPC from outside the DO: production
Cloudflare clocks advance after I/O, so timing synchronous SQL inside the DO
would misreport zero. Timings include dispatch, operation assertions, storage
and coordination. Full-body validation and final teardown are outside timing.
The request colo shown in the UI does not identify the DO's location.

The suite runs 100 and 1,000 approximately 0.8 KiB files, with/without the
existing 4,096-entry metadata cache. It alternates cache order and discards one
full warmup before three samples. It exercises writes, stat, stat after one
overwrite, reads, listing, append, rename, recursive copy/remove and real Git
init, populate, add, commit, status, diff, log, branch and checkout. Direct-engine Git add
uses batches of 32 existing filepath arguments to bound concurrent zlib
compression under the isolate memory limit. R2 and network Git transfers are
outside this public suite. No uploaded scripts, sizes, URLs or paths are accepted.

The separate `git-shell` group executes the registered Git applet through
`Shell`, including scope checks and execution budgets. It measures
initial staging, unchanged staging, one-file staging, staging all deletions and
same-VFS bare/worktree clone, unchanged fetch and pull, one-commit push and pull
on 100/1,000-file repositories. Shell staging uses 32-path batches, extending
small-body batches to at most 128 paths only within 1 MiB of inspected bodies;
removal-only batches hold up to 1,024 paths. New blobs avoid comparison reads;
overlapping configuration reads are shared without retaining completed values.
Worktree inspection bounds concurrent body reads/hashes to 32.
It has no adapter-cache variant. Validation
outside the timer checks the changed staged blob, empty final index and
local remote references and cloned bytes. Existing `git` rows retain their direct-engine
workload, so they remain comparable with earlier results.
The shell suite also edits every tracked file and stages those changes; validation
reads every staged blob outside the timed interval. A separate deletion-staging row
executes 20 rounds with index-byte resets and empty-index assertions included in its
timed interval, restoring the original index before the one-shot deletion row.
This measures changed worktrees
separately from initial add, unchanged add and a selected one-file add.
The fixed shell benchmark uses a 128 MiB I/O budget for both versions so the
baseline's repeated index rewrites can complete. A separate correctness test
checks 1,000 deletion staging under the default 32 MiB shell budget.
When comparing against a saved result from before this group was introduced,
pass `--allow-added-workloads` to `bench:public`. New rows are explicitly marked
as having no baseline; every older row must still match. Default comparisons
continue to require identical workload sets.

Results, observed limitations and deployment verification are in the
[evaluation](../bench/public-benchmark-evaluation-2026-10-08.md).


### Repeated production performance evaluation

`npm run bench:public -- --out /tmp/baseline.json` requests a fresh production
run using `CF_VFS_PUBLIC_BENCHMARK_TOKEN` or ignored `.dev.vars.public`.
After a measured implementation change, deploy with
`npm run deploy:public`, then run
`npm run bench:public -- --baseline /tmp/baseline.json --out /tmp/candidate.json`.
The command polls the background job, saves raw samples, and prints matched
operation median ratios. These three-sample ratios are descriptive; repeat noisy
runs before retaining a performance change. The public page still uses the
10-minute mtime rule. The separately authenticated POST `/api/benchmarks/developer` bypasses
freshness but never starts a second concurrent run. Secrets stay out of the UI.
Successful results include the CF deployment ID and the latest 20 runs remain at
`/benchmarks/history/<run-id>.json` in the VFS. A deployment change interrupts an
active old-version run rather than publishing mixed-version samples. The CLI
archives results locally for comparisons across longer histories. This mechanism
adds no library API and makes no automatic code changes or deployment decisions.

The deployment command fingerprints the current library, demo, lockfile and
configuration before bundling. The evaluation CLI requires that fingerprint on
both the HTTP Worker and DO and checks the completed run ID; mismatched or stale
results are refused. Transient deployment propagation responses retry for up to
ten minutes. Use `deploy:public` for measured deployments; calling Wrangler
directly does not regenerate the fingerprint.

## Optional Git in the terminal

The demo explicitly registers the [optional Git applet](../docs/git.md). Local
clone/fetch/push operate between repositories in the room's VFS; network Git
remotes and host paths are unavailable. Initialize a repository, configure
`user.name`/`user.email`, then add and commit files. Use a bare local repository
as a push target. These operations obey the room's existing execution budgets.

Git staging uses bounded atomic loose-object writes before index publication;
small changes retain ordinary individual writes. The demo's collaborative and
credential views forward backend buffer headroom so the same optimization can
run under its smaller limits. Existing public benchmark rows measure this path
without changing their clocks or iteration counts.

The public suite also includes connected coding sessions at 100/1,000 files:
768-byte files and a mixed profile with four poorly compressible 256 KiB bodies.
It checks local clone, edits/additions/deletions, partial staging, commit selection
and complete checkout bytes. Isolated recovery rows inject object/index failures,
cancel add, fail a later add batch, test host-serialized shells, and demonstrate
explicit forced checkout recovery after a partial checkout. Recovery timings include fixture
creation, failure, retry, validation and teardown; they are not command latency.
See the [coding evaluation](../bench/git-coding-evaluation-2026-10-09/report.md).

Shell source units and document mutations/publications share a bounded room-wide
queue. This protects repository work from another session's commands and editor
changes, including local clone sources and destinations. Queued/active work can
be cancelled; disconnection skips queued work. Document subscriptions include
readers, and accepted edits are acknowledged to the author. Publication failures
retain pending text, report an error and allow commands that free storage quota.
`git checkout --force REF` explicitly restores tracked files after partial
checkout; ordinary checkout continues to protect dirty changes. The
[recovery and diff report](../bench/git-recovery-coordination-2026-10-09/report.md)
contains reproduction commands and deployed evidence.

Editor version acknowledgments confirm acceptance into the in-memory document,
not durable publication. Pending text, including edits retained after quota
failure, can be lost if the object restarts before publication succeeds.
The [coding durability evaluation](../bench/coding-durability-2026-10-10/report.md)
separately checks completed Git data, actual checkout resets and queue latency.
