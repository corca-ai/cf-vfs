# CF VFS optimization evaluation — 2026-10-09

Status: implementation, deployment, production repetition and completion audit verified. Two-hour window: 2026-10-08
21:44:42–23:44:42 UTC. Early sandbox restrictions were resolved; production
iterations then ran on vfs.borca.ai. No public filesystem API was added.

## Retained changes

- Git add prunes unrelated paths before stat/body reads and skips unchanged
  content/mode. A command-local index cache spans inspection and staging.
- Blob staging remains bounded to 32 paths. Removal-only staging batches 256
  paths without retaining bodies. Ignore decisions are reused for eligible
  paths; missing ignore-file probes are cached only within read-only inspection.
  Successful reads and cross-command results are never cached.
- Default-mode Git writes avoid redundant target inspection while preserving
  existing modes, nondefault umasks, credentials and scoped write planning.
- Non-directory removal reuses exact deletion and exact tombstone publication.
  Directory removal retains its existing set-based path. Hard links, open
  inodes, sticky bits, opaque-object GC, events and transactions are preserved.

## Repeated production evidence

Each workload uses one warmup and three measured trials on Cloudflare. Times
include Worker-to-Durable-Object RPC dispatch and operation assertions; full
body validation and teardown are outside timing. This is wall time, not CPU
usage. Fixtures use inline bodies and local VFS Git remotes, not R2 or an
external network. CF variance makes small timing differences inconclusive.

| Shell operation, 1,000 files | Earlier implementation | Retained improvements |
| --- | ---: | ---: |
| Initial add | 4,720 ms | 3,482–3,615 ms |
| Unchanged add | 2,704 ms | 212 ms in removal repeat |
| One-file add | 367 ms | 82 ms in removal repeat |
| Stage all deletions | 10,723 ms | 77–94 ms |
| Remove individual files | 3,195 / 3,541 ms before exact removal | 142 / 94 ms |

Sources: [staging baseline](cf-baseline.json), [staging candidate](cf-git-candidate.json),
[staging repeat](cf-git-repeat.json), [pre-removal run](cf-git-write-candidate.json),
[pre-removal repeat](cf-git-write-repeat.json), [removal run](cf-remove-candidate.json),
[removal repeat](cf-remove-repeat.json). Different stages are named explicitly:
removing working files and staging those deletions are separate operations.
Each full 15-operation suite passed 27,048 assertions (118 rows).

Local alternating paired trials independently support the major improvements:
[staging](git-shell-paired.json), [removal batches](git-delete-batch-paired.json),
[missing ignore probes](git-ignore-paired-repeat.json),
[Git write transfers](git-write-transfer-paired.json), and
[exact removal](remove-paired.json). Exact removal reduced 1,000 deletions amid
4,000 unrelated bodies from 363.30 to 11.38 ms. Workerd billed-row guards
independently verify bounded cost amid unrelated inline and opaque objects.
Node SQL returned-row counters are not Cloudflare billed rows.

## Rejected experiments

- Append query fusion saved one SQL statement but had no repeatable latency
  benefit and grew the core bundle. Restored the prior implementation.
- Binary digest probe did not address a real hash cost: ordinary writes already
  avoid the incoming digest. Tiny local difference was inconclusive; restored.
- Directory-kind transfer snapshots improved local transfer costs but produced
  no reliable CF gain and slower clone results. Restored.
- Four-way nonblocking checkout showed no local gain and mixed CF clone medians
  (1,951 then 3,203 ms versus serial 2,318 / 2,625 ms). Restored serial checkout.
- Direct GitIndexManager use exceeded the unchanged optional Git bundle budget.

Raw evidence and chronological experiment details are preserved in
[iteration notes](iteration-notes.md), including rejected intermediates.
An early pull-baseline deployment overlapped a source edit. It was discarded
before measurement; the baseline was redeployed from restored source with a
new fingerprint and awaited to completion before the candidate was restored.

## Actual filesystem comparison

[Raw probe](git-native-vfs-latest.json), [summary](git-native-vfs-summary.json):
Node 24.18.0, Apple M5 Max, identical isomorphic-git 1.43.1, macOS temporary FS
versus SQLite VFS, 1,000 files, two warmups and five trials, instrumentation off.
These are direct-engine local timings, not native Git CLI or CF timings.

| Operation | Actual FS median ms | VFS median ms |
| --- | ---: | ---: |
| Populate | 78.27 | 20.71 |
| Initial add | 137.40 | 120.15 |
| Commit | 4.56 | 3.28 |
| Clean status | 20.21 | 20.32 |
| One-file add | 1.43 | 1.22 |
| Checkout old | 16.74 | 27.55 |
| Checkout main | 17.84 | 27.46 |
| Push | 175.40 | 137.10 |
| Clone | 138.30 | 132.76 |

Checkout remains a 1.5–1.6× local gap. The direct engine's same-second stat
cache limitation remains observable; the shell hashes actual bytes to avoid it.

## Verification and public benchmark

Full candidate checks: 1,880 Node tests, 142 workerd tests, POSIX 46/46,
types, lint, knip, quality, documentation, isolated package consumers and all
12 bundle presets pass. Performance guards pass 17 Node measurements and
31 workerd checks. Git bundle 540,689 / 563,968 bytes; VFS core
207,721 / 213,504 bytes (256-byte growth for exact removal). Default shell
235,191 and default registry 502,036 bytes remain unchanged.

The public benchmark now measures actual shell Git separately from direct
engine Git and file operations. The unchanged-pull workload expands it to
120 rows and 27,056 assertions. GET only displays saved results; public requests
reuse a result younger than ten minutes using the VFS file mtime; concurrent
requests share a durable background run. Authenticated development refreshes
verify matching Worker/DO build fingerprints. Old results remain visible while
new jobs run. Final deployment and pull results follow below.

## Unchanged-pull candidate

After local fetch and the existing full clean-tree/index check, equal local and
remote commit IDs skip dry-run checkout, merge and checkout. Missing/unborn
refs use the existing path. Dirty trees still fail; HEAD and index mutation
tokens remain unchanged on up-to-date pulls. Changed pull remains serial.
[Alternating local pairs](git-pull-paired.json): unchanged pull 133.52→76.74 ms,
12,894→7,231 SQL calls; changed pull 135.63→135.30 ms, with 24 extra probes.

[CF baseline](cf-pull-baseline.json): unchanged pull 677 ms for 1,000 files;
[candidate](cf-pull-candidate.json) 262 ms and [repeat](cf-pull-repeat.json)
275 ms. All runs pass 27,056 assertions. The candidate's ROOT unchanged-add
row measured 1,468 / 1,685 ms versus 213 ms in the baseline, despite the pull
optimization targeting the separate COPY repository. The restored baseline control and fresh candidate repetitions below resolve
retention; slower samples remain included.

### Reproduce production evaluation

Deploy with `npm run deploy:public` and await its terminal success before
editing implementation files. Then run:

```sh
node bench/public-remote.mjs --out /tmp/cf-result.json \
  --baseline bench/cf-improvement-2026-10-09/cf-pull-baseline.json
```

The developer token is loaded from ignored `.dev.vars.public` or the dedicated
environment variable. It is never printed or stored in these artifacts. The
CLI verifies the implementation fingerprint and run/deployment identity.
Public visitors use the ten-minute policy; only this authorized development
endpoint bypasses freshness. No external Git hosting is involved.

The [restored control](cf-pull-control.json) measured unchanged pull 627 ms,
unchanged add 276 ms. A [fresh candidate deployment](cf-pull-final.json)
measured unchanged add 232 ms, disproving a consistent staging regression,
but unchanged pull was 1,247 ms (samples 1,605 / 222 / 1,247), and changed pull
also had large stalls. The source change does not solve CF tail latency.
It is retained for its independently confirmed elimination of unnecessary
checkout/ref publication, local paired gain, and two initial CF gains; do not
interpret it as a guaranteed production percentile improvement. The final repeat below confirms the typical improvement while retaining the
slow samples as evidence of unresolved tail latency.

Final deployment: 89e2b847-42bb-457d-9e7d-8f60b448a5d3; implementation
62841a6be3a2e0c97d7c995514fb7d33c350c697dc32d43cda5ef645dccbc847.
The actual public shell passed init/config/add/commit, bare/worktree clone,
unchanged pull, changed commit/push/pull, byte inspection and unique-directory
cleanup: [terminal capture](public-shell-final-smoke.txt). Public requests during
an active run returned `reused: true`: [capture](public-running-reuse.json).

### Final repeat and completion audit

[Final repeat](cf-final-repeat.json) passed 27,056 assertions across 120 rows.
For 1,000 files: initial add 3,798 ms, unchanged add 228 ms, one-file add 86 ms,
individual removal 106 ms, deletion staging 81 ms, unchanged pull 287 ms.
Unchanged pull samples are 868 / 267 / 287 ms; three of four candidate-run
medians improve over both baseline/control medians. Clone worktree remains
3,142 ms and changed pull 2,248 ms. These remaining costs and outliers are
explicitly unresolved, not presented as universal speedups.

The live saved result matches final deployment/build/run. Public POST reused
that same run and exact file mtime; `nextRunAt - modifiedAt` is exactly 600,000
ms: [freshness evidence](public-final-reuse.json). The browser request button
also reused the saved result. Rendering was inspected, including separate
file/direct-Git/shell-Git tables and unchanged-pull row. The final source
fingerprint was independently recomputed and matches the deployed image.
Current append/binary source matches the pre-experiment snapshot; rejected
nonblocking checkout and directory-kind transfer changes are absent.
Documentation links and whitespace checks pass after final report updates.

There are 24 completed production evaluations in this directory, each with
its own run, deployment and implementation fingerprint. All are preserved;
accepted gains, rejected experiments and the retained pull caveat are above.
The original two-hour scope is satisfied by repeated code/check/deploy/real-CF
iterations, preserved declared POSIX behavior, updated public workloads and
final live verification. No commit or package publication was performed.
