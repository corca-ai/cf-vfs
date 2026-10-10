# Connected Git coding and recovery evaluation — 2026-10-09

This evaluation adds repeatable public workloads without changing the library's
FS API or Git behavior. The deployed suite retains VFS-persisted results and the
10-minute modification-time freshness rule.

## Workloads and measurement

100 and 1,000 flat files. Small profile: 768-byte deterministic printable bodies.
Mixed profile: four 256 KiB deterministic poorly compressible bodies, remaining
files 768 bytes. Every trial prepares a fresh committed source, clones locally,
checks clean status, modifies f0, deletes f1, adds a file, inspects status/diff,
stages only the modification/addition, commits that selection, stages/commits
the deletion, switches to base and back to main, then checks clean status.

Full clone and checkout bodies, index paths, retained unstaged deletion and the
three-commit history are verified outside operation timers. One warmup plus
three samples; report medians and retain raw samples. Clone timing includes
identity configuration; preparation includes population/add/commit. Mixed diff
includes replacing a 256 KiB tracked file with a short text file. These are
local VFS remotes, not network clones or R2 tests. There is no before/after
optimization or native Git CLI comparison in this evaluation.

Local reproduction: `node bench/git-coding-evaluation-2026-10-09/local.mjs`.
Public reproduction after deploy: `node bench/public-remote.mjs --out bench/git-coding-evaluation-2026-10-09/cf.json`.

## Recovery contracts

All public fault probes run in private scratch paths in the isolated benchmark
VFS. Batch capacity (`ENOSPC`), missing parent (`ENOENT`), and index capacity
errors are deliberately injected, not a Cloudflare infrastructure outage.
Mid-add cancellation is a real AbortSignal triggered by a worktree read.

- First-batch object failure, index-write failure and mid-add cancellation leave
  the previous index bytes and HEAD unchanged. A fresh command retries, commits,
  and reads every resulting blob successfully.
- Failing batch two of a 256-file add leaves the first 128 newly staged files
  plus the seed in a valid readable index, with unchanged HEAD. Retry completes
  all 256. Add is not a whole-command transaction.
- A separate pair of concurrent add commands selects two distinct files and
  preserves both selections in this single-isolate test. The installed engine
  has a process-wide index lock keyed by path; this narrow success does not cover
  concurrent edits/checkout/transfers or separate isolates.
- Two independent Shell instances submit simultaneously to a host-owned queue.
  Both complete with all files staged. Uncoordinated writers remain outside the
  documented contract; this is not proof of a distributed repository lock.
- Checkout write eight fails after some files change. HEAD and committed blobs
  remain valid, but the working tree is partial. Plain checkout retry is rejected
  by dirty-tree protection. Explicit host restoration to known committed bytes
  makes checkout retry succeed. **There is currently no applet command for hard
  reset/forced checkout recovery.** This is the clearest usability gap found.
- Separate Node/workerd tests lower the real backend logical-byte quota, verify
  failed add preserves the index, restore capacity and successfully retry. These
  real quota tests are distinct from the public fault-injection rows.

No isolate-kill, process restart, cross-DO distributed lock, failed clone cleanup,
or exhaustive filesystem crash-consistency claim is made. Benign dangling Git
objects after failed writes are allowed; indexed/committed objects must exist.

## Local result

Node v24.18.0, SQLite VFS and shell Git applet. 1,000-file medians in ms:

| Operation | Small | Mixed |
|---|---:|---:|
| prepare | 142.93 | 176.20 |
| clone | 158.19 | 166.40 |
| status-clean | 32.86 | 33.16 |
| status-dirty | 31.95 | 32.50 |
| diff | 119.23 | 131.26 |
| add-partial | 6.88 | 9.09 |
| diff-staged | 187.19 | 201.04 |
| commit-partial | 2.59 | 2.47 |
| add-rest | 32.25 | 32.89 |
| commit-rest | 2.40 | 2.54 |
| checkout-base | 62.94 | 67.81 |
| checkout-main | 63.19 | 63.39 |
| status-final | 31.61 | 31.76 |

Raw samples and all 100-file rows: [local.json](local.json). The benchmark
was rerun after local checks completed to avoid competing test CPU. The
operation-only coding sessions perform 26480 byte/history/path
checks across warmups and samples. Eight recovery probes pass independently.

## Verification and limitations

`npm run check` passes: Node 1,909 tests; workerd 154 tests; declared POSIX
46/46; type checks, lint, documentation, execution limits, isolated packaging
and all 12 tree-shaking/bundle presets. Git/library bundle bytes are unchanged
from the preceding deployment: this task adds demo/benchmark/test coverage,
not a filesystem API or library optimization.

The shared demo currently rejects overlapping commands per terminal session,
not via a repository-wide host queue; editor messages can also arrive during
a command. The narrow concurrent-add success is therefore not a claim that
the collaborative demo provides transactional repository operations. A host
coordination policy is still needed for multi-user coding.

## What to do next

1. Add an explicit recovery command/contract for partial checkout. Preserved Git
   history is useful, but users currently cannot repair the working tree entirely
   through the applet. Define destructive reset/force semantics carefully; do not
   automatically discard edits on ordinary checkout failure.
2. Coordinate repository writes and editor mutations at the host boundary. A
   single process's index lock is narrower than a repository transaction and does
   not make a source stable throughout local clone or serialize checkout with
   editor changes. The demo's per-session execution guard is insufficient for
   this broader contract.
3. Profile and optimize diff path selection before adding another FS API. Current
   `gitDiff` walks the tree and loads both sides' blob contents before checking
   byte equality in the renderer, including unchanged tracked files. In the
   1,000-file local session, unstaged and cached diff cost much more than partial
   staging or committing. This is a measured candidate, not an optimization
   performed or a promised speedup in this task.

## Actual Cloudflare result

Deployment `50612400-4df3-49bb-bc22-50e4ca9e3407`, source fingerprint `d188dd95fff1982c73ce7e6792d17da7acdb64dbd6b5653532c98a89bd7e7de1`,
run `1638ed82-bd34-4d60-a942-ba4f522f693b`, request colo LAX.
190 rows, 60,648 checks, one warmup and three measured samples.

1,000-file operation medians in ms:

| Operation | Small | Mixed |
|---|---:|---:|
| prepare | 3599 | 4523 |
| clone | 4035 | 4705 |
| status-clean | 84 | 1573 |
| status-dirty | 1119 | 138 |
| diff | 2351 | 3548 |
| add-partial | 69 | 66 |
| diff-staged | 2671 | 3423 |
| commit-partial | 136 | 90 |
| add-rest | 166 | 127 |
| commit-rest | 166 | 134 |
| checkout-base | 1461 | 1439 |
| checkout-main | 428 | 471 |
| status-final | 71 | 807 |

Raw samples: [cf.json](cf.json). Variance is substantial: mixed clean status
was 252/1,759/1,573 ms and mixed final status 76/807/1,386 ms. These three-sample
medians describe this run and do not establish a universal small-vs-large ratio.
There is no optimization speedup claim in this evaluation. Clone includes identity
configuration; each timed RPC includes platform dispatch.

All eight recovery scenarios passed on real CF. The capacity and missing-parent
failures are injected at the isolated VFS capability boundary; real quota
exhaustion is separately tested on Node and local workerd. Checkout partial
worktree, dirty retry rejection, preserved history and explicit host repair were
all reproduced on CF. Recovery rows time the entire probe, not just one command.

The production fingerprint matches all 205 deployed source/config/asset files.
Public GET matches the saved result and deployment. An unauthenticated POST
reuses the same run and VFS file mtime, with a 600,000 ms freshness window.
The public UI renders both coding tables and the recovery table with no browser
errors. Evidence: [source-fingerprint.json](source-fingerprint.json),
[public-reuse.json](public-reuse.json), [public-ui.txt](public-ui.txt),
[check.log](check.log), [deploy.log](deploy.log).

Recovery rows are displayed under the public page's **100 files** selection
(the probes use fixed private fixtures rather than the selected coding scale).
Their UI was separately checked in [public-ui-recovery.txt](public-ui-recovery.txt).
