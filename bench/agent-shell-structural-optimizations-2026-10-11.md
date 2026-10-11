# Structural agent-workload optimization, 2026-10-11–12

This round keeps an optional incremental Git staging command and rejects the
jq and pipeline prototypes. No filesystem methods or schema changes are added.
The intended workload is a long-lived, change-recorded agent workspace which
repeatedly edits a few files and runs `git add .`. The default Git command remains
independent; its Wrangler bundle is byte-identical to the baseline.

## Scope and implementation

`createTrackedGitCommand(workspace)`, imported from
`@corca-ai/cf-vfs/shell/commands/git-tracked`, retains a checkpoint after a
successful whole-tree add. The existing `changesSince` feed identifies changed
paths; unchanged index, credentials, policy and limits allow the wrapper to
select changed regular files and invoke the ordinary Git implementation.
A successful commit of the unchanged index can retain the checkpoint. Index
serialization still scales with the repository: this is not an O(changes)
guarantee for the entire command.

The first call, restart, failed staging, external metadata/index changes,
changed ignore/config rules, permission changes, directories, deletion,
symlinks and more than 128 changed paths use a full walk. Any symlink in the
repository prevents reuse, since a normally named file can indirectly back
ignore rules, configuration or refs. A regression test first reproduced an
internal symlinked `.gitignore` dependency, then verified this fallback.
The tracker holds at most 32 repository checkpoints and 129 distinct feed paths,
while draining the existing paginated feed. Feed pages retain their existing
atomic-change semantics and are not a new hard heap limit.

Hosts must use the same trusted FS owner, serialize repository edits/commands,
and retain the command across executions. The shell still applies its normal
scoped roots, credentials, budgets and cancellation. Unsupported wrappers and
collaborative overlays select full staging. Recording is never automatically
enabled: switching it on adds mutation storage writes and requires a separate
whole-workload tradeoff. A fresh tracker also pays an initial discovery cost.

## Measurement

Baseline: `f127785d3c552a114160e4a00d3c2149ec7e4559`. Node 24.18.0,
lockfile-pinned dependencies. Raw measurements, rejected patches, exact graph
hashes, replay commands and checks are in the
[evidence directory](agent-shell-structural-2026-10-11/README.md).
Ratios below are candidate/baseline **time**, so lower is better. They are paired
ratios, not ratios of the separately reported medians. Confidence intervals use
the repository's paired bootstrap protocol.

The target has 1,000 files, ten modifications, fixed Git author time, three
warmups and 20 alternating pairs. Both arms use change recording. The CF target
recreates the fixture in the same Durable Object for both arms to avoid placement
confounding. It measures Worker-to-DO RPC wall time; status, diff bytes and
commit IDs are verified outside timing. SQL statements and native rows are
reported independently and are not converted into monetary savings.

| Target | Baseline median | Candidate median | Paired time ratio (95% CI) |
| --- | ---: | ---: | ---: |
| Local repeated add (release) | 19.940 ms | 7.530 ms | 0.3734 (0.3546–0.3965) |
| CF repeated add (release) | 401.5 ms | 202 ms | 0.4876 (0.4309–0.5032) |
| CF edit + add + commit (release) | 866 ms | 642.5 ms | 0.7432 (0.6973–0.7793) |
| Local cold tracker add | 20.862 ms | 23.698 ms | 1.1320 (1.1235–1.1371) |
| CF recreated tracker, natural cache history | 249.5 ms | 382 ms | 1.6321 (1.5260–1.7491) |

The separately measured CF phase medians do not sum to the cycle median.
Final warm CF data is `cf-git-accepted.json.gz`, build
`structural-git-wrapper-v4`, deployment
`a074244b-3deb-4b73-9228-fb4fc9be44c4`. All 20 pairs completed without retry.
The preceding symlink-hardened v2 also improved (paired add ratio 0.4005 and
cycle 0.6539; one whole pair retried after an actor restart), as did v1 (0.5883
and 0.8716). Absolute RPC latencies vary by placement and time, so paired
comparisons matter more than cross-run medians. V4 additionally validates every
`-C` operand before taking a no-op fast path. Cold diagnostics used v2/v3,
whose differences from the release are confined to that `-C` branch; these
workloads have no `-C` operands. All default-suite library modules are unchanged.

| CF native SQL, medians | Baseline | Candidate |
| --- | ---: | ---: |
| Add statements | 1,509 | 454 |
| Add rows read | 4,589 | 1,691 |
| Add rows written | 104 | 104 |
| Whole cycle statements | 1,887 | 838 |
| Whole cycle rows read | 5,920 | 3,126 |
| Whole cycle rows written | 278 | 278 |

Checkpoint maintenance adds a few queries to commits and changes the warm
metadata state of edits (edit median 59→60 statements; commit 319→324).
The complete cycle is reported to account for those costs. The add and complete-cycle improvements recur across the three CF runs.
The final commit phase has a smaller favorable time signal (ratio 0.9491, CI
0.9034–0.9723), but earlier commit intervals include no change; no independent
commit optimization is claimed. The edit interval includes no change.

The cold local cost is real: creating a new tracker before every add loses the
benefit and adds about 13% time, including feed discovery and a symlink check.
On CF, recreating the tracker after the natural prepare history was **63.2%
slower** for add and **12.6% slower** for the edit/add/commit cycle (paired CI
1.0709–1.1739 for the cycle). This case also has different content-hash warmth:
ordinary Git's final no-op setup add hashes the tree, while incremental Git
skips that scan. Recreating the tracker then forces it to discover those hashes.
Its add profile is 1,509→2,508 statements and 4,589→21,588 rows read, with 104
rows written on both sides. This is retained as a real lifetime disadvantage,
not discarded as noise. The additional 20-pair matched-hash diagnostic explicitly runs status/diff
before the timed edit on both arms: add medians **444→443 ms**, paired ratio
**0.9360** (95% CI 0.8862–1.0467), cycle ratio **0.9752** (0.9470–1.0388).
Neither is a proven latency change. Its SQL profile still shows the checkpoint
construction cost: **1,509→1,518 statements, 4,589→19,608 rows read**, and 104
rows written on each side. Draining historical changes and checking symlink
eligibility are paid once per successful checkpoint; frequent invalidation or
short command lifetimes can make this tradeoff unfavorable. No dollar-savings
claim is made. Both cold results are retained in `cf-git-wrapper-cold*`;
the diagnostic does not replace the natural-history result.
Cold here means a recreated command/tracker; it is not a full isolate startup
latency measurement. This is unsuitable as an unconditional per-execution default. The retained API
is for a persistent command in an already change-recorded workspace.

Complete default-command controls: local overall time ratio **1.00133**
(95% CI 0.96122–1.04133), files **0.99967**, Git **1.00254**, cache **0.98990**.
All 190 rows ran with ten paired trials. Sixteen >5% flags had no confidence
interval excluding no change. One failed-checkout profile differed by three
statements and one returned row; ten alternating-order repeats were identical
at 3,638 statements/3,184 returned rows on each side. These Node rows are
returned rows, not Cloudflare billed rows.

The complete CF default-command control ran all 190 rows with ten paired trials:
overall **1.01537** (95% CI 0.99887–1.04119), files **1.03484**
(0.97192–1.13222), Git **1.01656** (0.98890–1.02740), cache **1.01627**
(0.98102–1.05879). No native SQL cost increases were observed. There are **57 >5% flags**, nine
with confidence intervals above one. These are retained, not called a clean
performance pass. The nine signals span seven groups. A **same-code control** repeated all 92
rows in those groups with ten paired trials and identical baseline classes on
both sides (`same-code-control.patch`, `cf-default-aa`). Eight of the nine
original signals no longer have intervals above one. The 1,000-file mixed
checkout signal remains **even with identical code**: ratio 1.18738 (95% CI
1.08331–1.29700). There are 18 >5% flags in this known-null control, with that
single interval excluding one, and zero native SQL cost increases. This is
unresolved benchmark/environment sensitivity, not evidence that the optional
tracker changed default checkout. The matched default bundle and unchanged
library graph rule out such a code-path change. A generic claim of “no noisy
rows” or improved public aggregate would be incorrect.

Adoption is conditional: the persistent tracked-command workload has a repeated
CF latency and SQL-read benefit, and opting out preserves the original default
bundle. It is not an overall public-score optimization or a cold-workspace win.
Wrapper v1 and final v4 differ only in the optional tracker module; the full default
suite does not import it (`wrapper-final-graph-equivalence.json`). The ordinary
Git bundle is 561,140 bytes on both sides, SHA-256
`295a66105bfa3f991f039522a7c51e3b636376c9388b981c7cbe728332782667`.

## Rejected experiments

- jq result iteration: original ten-workload shell time ratio **0.99475**.
- jq lazy input values plus output iteration: ratio **1.00081**; the 1,200-record
  JSONL target regressed **8.4%** (95% CI for time ratio 1.036–1.120).
  Array projection improved about 5%, insufficient to justify adoption. This
  did not implement a fully incremental byte-stream JSON parser.
- Direct pipeline writer: original shell cohort ratio **0.9800**. A many-small-
  commands case improved about 6.5%, and a six-stage text pipeline about 3%.
  These gains did not justify the new stream ownership complexity. Backpressure,
  cancellation and limits checks passed; the implementation was still reverted.
- Git hooks in the default command: strong target gains, but the complete CF
  suite flagged 1,000-file mixed coding preparation at **1.09467** (95% CI
  1.02588–1.17559). All hooks were removed from default Git and its adapter.
  The retained wrapper deliberately trades some target speed for isolation.

The earlier off/on recording CF experiment increased rows written (staging
62→104, edits 30→50). This is why the accepted configuration is **opt-in for
workspaces already recording changes**, not a default setting change.

## Verification and delivery

The public FS/Git suite preserves its existing definitions and weighting; the
new Git target is not silently inserted into the public score. Deployment alone
does not enable the optional tracker in the demo shell.

The final `npm run check` passed 2,022 Node and 158 workerd tests, POSIX
semantics, 14 isolated execution-limit processes, documentation/package checks,
typecheck/lint/quality checks and all 12 bundle presets. `npm run bench:check`
also passed its native SQLite guards and 45 workerd benchmark tests. The new
tracker has 20 behavior tests, including a failing/passing reproducer for
repeated `-C` operands: each operand must name an accessible directory even when
a later absolute `-C` returns to a repository with an unchanged checkpoint.
Three pre-existing unused lint-suppression warnings remain.

Both temporary private Workers were deleted, their test rooms cleared, and the
owned local build graphs/credential symlink removed after hash-verified archival.
Shared credential files were retained. Knip also passes without restored graphs.
Public deployment uses source commit
`665c38dec817da15db006ba3de8c75069df0fa43`, Worker version
`af4b76e3-4520-4e53-b87f-e0a039c5f1d0`, and build
`2372eeb50aa33ba94d0964cdd8b38cc7e9af41d06ae29d0868a9153e181e3f2b`.
Fresh public run `f85809c3-9151-4173-bad2-873bf21cf00d` verified all **190 rows**
and **60,648 checks**, with the expected commit/build/deployment IDs. The public
WebSocket shell also matched the Bash/jq/sed/pipeline/supplementary-Unicode
workflow and removed its temporary workspace.

The three-sample public snapshot versus the captured baseline has time ratios
**0.96931 overall**, **0.95379 files**, **0.97151 Git**, **0.95109 cache**.
It still has **37 >5% flags**, zero unresolved zero timings, and the assessment
correctly returns `requiresReview: true`. This is descriptive verification,
not evidence of a default-command speedup or a regression-free timing pass.
The complete ten-pair controls, known-identical control, and byte-identical
default Git bundle above provide the relevant interpretation. The new tracker
is not enabled in this public default workload, so its target gains are not
claimed for the public aggregate or demo shell. See `public-verification`,
`public-assessment`, `public-candidate` and `public-smoke` in the evidence folder.
