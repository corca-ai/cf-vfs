# Git recovery, workspace coordination and diff — 2026-10-09

## Changes

- `git checkout --force REF` / `-f` invokes the engine's forced checkout after
  reference validation, bypassing ordinary dirty-tree refusal only when explicit.
  It repairs the selected committed worktree and index after partial checkout.
  Unrelated untracked content is retained; obstructing untracked content can be
  replaced. Existing permission, budget and cancellation boundaries remain.
- The demo uses one bounded (64 admitted operations) queue per workspace for
  shell source units, document open/edit/close, disconnect cleanup and deferred
  document publication. This covers clone endpoints, aliases and arbitrary
  shell mutations without unreliable repository-path inference. It is host
  coordination inside the shared DO, not a new library FS API or a distributed
  repository transaction. Signals, ping, resize and completion bypass the queue.
- Pending editor publications are attempted before/after commands. Quota failure
  retains dirty text and notifies readers; commands can still free space. A close
  that cannot save is refused rather than dropping text. Disconnected dirty text
  remains available for later publication instead of being silently discarded.
- Opening a document now registers a subscriber. Accepted edits acknowledge the
  author as well as other readers. The previous deployed demo failed both checks:
  the author did not receive the new version, so a second edit using the last
  acknowledged version was refused; another open reader received no broadcast.
- Cached diff skips matching blob object IDs. Unstaged diff hashes the worktree
  body once, skips identical blobs and inflates stored content only for changed
  paths. At most 32 body comparisons are active, including nested directories.
  No cross-command cache is introduced. Same-size rapid edits remain visible.

## Reproduction and evidence

`compare-diff.mjs BEFORE_DIST AFTER_DIST OUT` runs 3 warmups and 10 alternating
baseline/candidate pairs on 1,000 deterministic printable 768-byte files. Set
`DIFF_MODE=work-one|cached-one|cached-clean`. Timings exclude fixture setup and
validate patch selection/content outside the timer. `PROFILE_DIFF=1` separately
records SQL and physical read counts; its timing is diagnostic, not a speedup
measurement. Baseline is a snapshot of the exact preceding workspace build.

`probe-editor.mjs before|after` reproduces/validates actual WebSocket editor
acknowledgment and subscription. `probe-workspace.mjs` verifies two-shell ordering,
editor serialization/stale refusal, queued and active cancellation, queued
caller disconnect, and public-shell force checkout. Default target is real CF;
set `CF_VFS_PROBE_URL=http://localhost:8799` for `wrangler dev`. Probes create and
remove only their own unique paths in the shared country room.

The public benchmark's checkout-failure row now repairs through `git checkout
--force`, with no direct host file restoration. The serialized two-shell row
uses the same `WorkspaceOperations` implementation as the demo. Existing
connected coding workloads and VFS-backed 10-minute result caching remain.

All Git commands can still leave partial work after failure; forced recovery
requires restored capacity and can itself fail. A DO restart may interrupt an
in-flight command; the queue is not a crash journal. Native Git output ordering
is not claimed: the existing diff renderer emits concurrent per-path patches,
and comparisons normalize patch order while checking each patch's contents.

## Local measurements

Node v24.18.0, three warmups, ten alternating measured pairs. Timed runs
use the exact final library build with no SQL/read instrumentation.

| 1,000-file workload | Before median ms | After median ms | Paired ratio 95% CI |
|---|---:|---:|---|
| work-one | 117.365 | 30.965 | 0.2534–0.2682 |
| cached-one | 180.934 | 4.744 | 0.0252–0.0266 |
| cached-clean | 183.557 | 4.532 | 0.0243–0.0250 |

Structural diagnostics, measured separately:

| Workload | SQL before → after | Reads before → after |
|---|---:|---:|
| work-one | 12020 → 2061 | 4004 → 1038 |
| cached-one | 20019 → 39 | 6010 → 16 |

## Verification

`npm run check` passes (1,920 Node tests and 155 workerd tests); after an
additional untracked-obstruction test, the final Node suite passes 1,921 tests.
Declared POSIX
46/46 passes, along with type checks, lint, quality, documentation, limits, isolated packaging
and 12 tree-shaking/bundle presets. Git bundle 547,437 → 548,385 bytes (+948),
within its existing 563,968-byte budget. VFS and shell bundles unchanged.

The original force-checkout test and two diff I/O-budget tests failed before
implementation and pass afterwards. Mixed/binary/symlink diffs, same-size
edits, preservation of unrelated untracked files and replacement of a changed
symlink without following its outside target are covered.

Local workerd WebSocket probes pass all seven coordination/recovery scenarios,
and actual CF WebSocket probes pass them as well. Actual CF reproduces the old
editor acknowledgment/subscription failure before deployment and passes after.
Evidence: [editor-cf-before.json](editor-cf-before.json),
[editor-cf-after.json](editor-cf-after.json), [workspace-cf.json](workspace-cf.json),
[workspace-local.json](workspace-local.json), [check.log](check.log).

Production deployment: `495bb799-e567-4f5c-b56a-324d78ae630a`.
Source fingerprint: `f332f54de0d3905dab86a5373be4c7e02b44e995385698be40525395f9d13c76`.

## Actual Cloudflare evaluation

Both runs report LAX. One warmup and three measured samples per row; these are descriptive medians, not controlled paired confidence intervals. CF scheduling/dispatch variance remains substantial.

| 1,000-file profile / operation | Before ms (samples) | After ms (samples) | Median reduction |
|---|---|---|---|
| coding-small / diff | 2351 (2351, 3632, 1631) | 1246 (2170, 111, 1246) | 47.0% |
| coding-small / diff-staged | 2671 (2571, 2846, 2671) | 13 (68, 13, 12) | 99.5% |
| coding-mixed / diff | 3548 (2454, 3548, 3624) | 64 (162, 40, 64) | 98.2% |
| coding-mixed / diff-staged | 3423 (4226, 3136, 3423) | 33 (33, 28, 119) | 99.0% |

Final public run `54bdb7b0-9a46-4023-98d5-9efe93304edd`: 190 rows, 60648 checks. Recovery rows now exercise the explicit forced-checkout command; their changed semantics preclude a before/after latency claim.

Production verification matched all 206 implementation files to the deployed source fingerprint. A repeated benchmark request reused the same stored result and VFS modification time within the 600,000 ms TTL. Public UI displays the final measurements. Evidence: [cf-final.json](cf-final.json), [source-fingerprint.json](source-fingerprint.json), [public-reuse.json](public-reuse.json).
