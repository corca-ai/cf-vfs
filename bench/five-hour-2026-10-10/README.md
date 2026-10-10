# Five-hour performance experiments, 2026-10-10

Window: 10:39:23–15:39:23 UTC. Initial clean source: `a03a31d`.
Production source at start: `08b8e0b77759ca30539a1e369921b594a48c0aae`.

Adoption uses the full uncached 146-workload geometric mean (18 filesystem,
128 Git/coding/recovery). The 44 optional adapter-cache workloads are reported
separately. Individual regressions are investigated and disclosed; they do not
alone veto a proven overall improvement, following the user's explicit policy.
POSIX behavior, API compatibility, bounded caches, SQL costs and bundle guards
remain required. Credential-bound UID/GID 1000 represents the demo shell;
unbound public-default workloads are a separate control.

Both private CF engines import freshly compiled, immutable complete graphs.
Compatibility date stays 2026-07-24. The dedicated private Worker is
`cf-vfs-five-hour-evaluation`; timing and native SQL profiling are separate.
Local returned rows are diagnostic and are not Cloudflare billed rows.

## Experiments in progress

- Local identical-code A/A, ten alternating pairs: overall candidate/baseline
  latency ratio 0.9982, bootstrap 95% CI [0.9943, 1.0042]. No confirmed latency
  regressions. Two tiny returned-row variations occurred with identical source;
  `profile-aa.json` records query-level evidence, without a claimed cause.
- Lazy traversal-cache clearing: rejected after full local ten-pair ratio
  1.0006 [0.9970, 1.0070]. No candidate CF deployment. Archived patch retained.
- Canonical ancestor enumeration: focused traversal tests pass (5/5), native
  POSIX comparison passes (46/46). Full credential-bound local ten-pair ratio
  0.9836 [0.9756, 0.9881]; SQL profile has no increased costs. One confirmed
  individual timing flag (`coding-mixed/add-rest`, 100 files) is under review.
  Unbound local control and actual CF validation remain pending; not adopted.

Raw JSON retains paired durations, workload identities, verification and SQL
profiles. Driver commands are the three-hour `compile.mjs`, `local-pairs.mjs`
and `remote-pairs.mjs`, with graph/output paths in this directory. Local runs
use `FIXED_GIT_TIME=1 STAGE_ORDER=1 PAIRS=10 WARMUPS=1`, and either
`CREDENTIALS=demo` or `none`. CF A/A starts with five pairs and one warmup.

- Canonical enumeration shared with the plain-entry lookup: full local ten-pair
  credential-bound ratio 0.9714 [0.9644, 0.9794]; unbound control 1.0012
  [0.9932, 1.0121]. Two returned-row-only flags (+4 and +1), with unchanged
  statement counts. A separate incremental comparison against the narrower
  candidate is neutral: 0.9977 [0.9872, 1.0023], so the apparent extra gain
  across separate runs is not claimed. Sharing the implementation also removes
  duplicate ancestor construction. CF validation is pending.

- Actual CF identical-code A/A, five alternating full-suite pairs: overall
  1.0060 [0.9743, 1.0234], native SQL costs identical. Seven pointwise individual
  confidence intervals flag regressions despite identical source. They are
  investigation signals, not family-wise proof of seven causal regressions.
  Candidate CF evaluation therefore uses at least ten pairs and the full
  aggregate as the primary outcome.

- FIFO traversal-cache eviction, preserving the 256-entry bound: six traversal
  behavior tests pass, but full local ten-pair comparison against canonical
  lookup source is neutral, 1.0011 [0.9976, 1.0058]. Rejected without CF trial;
  the existing eviction policy remains in source.

Canonical lookup private CF deployment: build
`five-hour-canonical-b295ad076aa5`, version
`b8af8be5-410b-4a78-bd12-f977426f42da`. Full UID/GID1000 ten-pair evaluation
is running. Production has not changed. Complete Node and Workers unit suites
pass on this source, including the new traversal behavior tests.

- Structured canonical helper: full UID/GID1000 local ten-pair ratio 0.9771
  [0.9663, 0.9793]. File and function quality limits are satisfied after moving
  canonical/general traversal calculation into an internal module. This final
  form is not the currently deployed private CF graph and needs CF validation.
- One-pass short canonical ASCII check: incremental local ten-pair UID/GID1000
  ratio 0.9930 [0.9894, 0.9988], independent repeat 0.9956 [0.9909, 1.0022].
  Unbound ten-pair control 0.9848 [0.9794, 0.9894]. Path-related tests 35/35 and
  native POSIX 46/46 pass. No native CF claim yet.
- Reuse metadata already returned by stat/list/listPage: targeted query count
  fails before optimization (3 rather than required 2) and passes afterwards;
  authorization is still checked per principal, after chmod too. Full local
  incremental ten-pair ratio 0.9966 [0.9900, 0.9974], aggregate statements
  605607 -> 604275, returned rows 710277 -> 701493. Eight individual SQL flags
  remain (1–3 extra statements during some checkout groups), despite lower
  aggregate cost. Two timing flags are investigation signals. Not adopted yet.
- FIFO eviction combined with directory metadata reuse: ten-pair incremental
  ratio 0.9981 [0.9932, 1.0033], eight SQL flags remain. Rejected; existing
  full-clear policy restored. Both standalone and combined FIFO patches remain
  as rejected experiment evidence.

- Git removal correctness: real credential-bound tests reproduce swallowed
  EACCES/ENOTEMPTY rejections in unlink/rmdir. Returning the removal Promise
  (mapped to void) restores caller rejection and fatal-error tracking. Before:
  2 failing tests and 2 unhandled rejections; after: related 30 tests pass and
  native POSIX matches 46/46. Incremental full local ten-pair comparison is
  0.9953 [0.9937, 0.9978], no confirmed timing or SQL cost flags. Treat this
  primarily as a correctness fix; unrelated file-only timing differences are
  not causally attributed to the Git change.

- Deferred cached permission denial to eliminate the parent array: local
  incremental ten-pair ratio 0.9980 [0.9953, 1.0011]. Rejected; the existing
  check sequence is restored.
- Canonical lookup actual CF ten pairs: overall 0.9674 [0.9424, 1.0083],
  files 1.0219 [0.9783, 1.1078], Git 0.9554 [0.9420, 1.0061], optional adapter
  cache 1.0213 [0.9595, 1.0605]. Three individual timing signals, zero native
  SQL cost increases. This remains insufficiently precise standalone evidence;
  final round-one source is evaluated again rather than silently adopted.
- Combined round one (canonical helper, one-pass path check, directory metadata
  reuse, committed removal fix): full local ten-pair initial-baseline comparison
  0.9577 [0.9540, 0.9627] for UID/GID1000; unbound control 0.9923
  [0.9852, 1.0005]. Private CF build `five-hour-round1-6cf5ee997e5b`, version
  `39a1cd31-faec-4448-b74c-64db879caf07`, ten full UID/GID1000 pairs in progress.
  Immutable TS source is held in the owned round-one worktree and patch.
- Query-plan diagnostics locate full namespace scans in rename publication and
  UPDATE, and a wrongly ordered recursive POSIX-copy join. The SQLite optimizer
  overview documents CROSS JOIN loop-order control:
  https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join
- Recursive POSIX-copy join now drives one parent and seeks indexed children.
  Native local workerd read rows for 100/1000 files change from 12149/1021049
  to 1745/17045; statements 12 and writes 410/4010 are unchanged. Content,
  ownership, new identity and source-preservation checks pass; 26 relevant Node
  POSIX tests and 46 native comparisons pass. Full incremental local ten-pair
  overall 0.9941 [0.9900, 1.0001], files 0.9172 [0.9023, 0.9249], Git 1.0059
  [1.0012, 1.0115]. Native CF validation pending; not adopted.
- Single-entry move uses the transaction's known source row for tombstone
  publication and primary-key UPDATE. Directories retain the existing subtree
  path. Native workerd rename beside 100/1000 unrelated files changes read rows
  from 226/2026 to 21/21; statements 15 and writes 10 unchanged. Identity,
  source/destination token changes and contents pass; relevant Node POSIX and
  native-oracle checks pass. Incremental full local ten-pair overall 0.9887
  [0.9835, 0.9916], files 0.9335 [0.9132, 0.9460], Git 0.9961
  [0.9928, 0.9998]. Native CF validation pending; not adopted.

At this checkpoint only `13b1106` had been pushed. The adoption update below
supersedes this intermediate state.

- Round-one actual CF ten pairs completed: overall 0.9936 [0.9857, 1.0062],
  files 1.0119 [0.9869, 1.0224], Git 0.9910 [0.9835, 1.0042], cache 1.0075
  [0.9830, 1.0212]. Fourteen timing signals, three confirmed pointwise, eight
  native SQL cost flags. Aggregate improvement is not established; not adopted.
- Round-two source is compacted to retain existing bundle budgets. Cache metadata
  projection is centralized in rememberTraversalParent; single-entry moves use
  indexed path equality (not a namespace range). Native rename read rows are
  22/22 beside 100/1000 files; the wide rename guard tightens 2012 -> 8 rows.
  The equivalent ASCII regex excludes code units outside 1..127 in one check.
  Full Node/Workers tests, native POSIX 46/46, all 35 SQL performance checks and
  all 12 unchanged bundle budgets pass. Final complete graph hash begins
  006ba6e7000d; private build five-hour-round2-006ba6e7000d, Worker version
  6872488c-3056-47ee-baaf-32bbeff2668c. Cumulative local evaluation is in progress.

- Final compact round-two cumulative local ten pairs: UID/GID1000 overall
  0.9386 [0.9333, 0.9399], files 0.8317, Git 0.9543, cache 0.9068; zero timing
  flags. Unbound overall 0.9877 [0.9780, 0.9958], files 0.9202, Git 0.9961,
  cache 0.9613; four unconfirmed timing signals. UID SQL statements aggregate
  605605 -> 604275 and returned rows 710268 -> 701493; ten individual cost
  signals include small metadata-cache churn increases and two returned-row
  jitter signals. Local returned rows are not native CF billable reads.
  Round-one native CF totals were 553153 -> 551818 statements,
  8185228 -> 8069371 reads, writes unchanged at 227815; eight individual
  cost increases remain, mostly checkout cache churn. Round-two CF is running.
- Inode lookup experiment replaces a full namespace OR/order scan with the
  union of primary-key and link-identity indexed candidates, selecting the same
  lowest id. Native local workerd plain/alias fstat costs are 2/3 reads beside
  both 100 and 1000 unrelated files; small writes 1011 -> 6 reads, full writes
  1041 -> 36, 1MiB truncate 2042 -> 38, statements/writes unchanged. Existing
  descriptor and hard-link tests pass (19). Full incremental comparison pending.
  Not adopted. A lint annotation explains intentional NUL detection in the
  canonical ASCII regex; it adds no runtime behavior.

- Indexed inode lookup full incremental local ten pairs is neutral: overall
  1.0015 [0.9988, 1.0047], zero cost increases in the unchanged public plan.
  Public workloads do not directly use descriptors, so the cost benefit needs
  separate real-CF probes before adoption. Before native scaling reads are
  102/1002 for plain and alias stat; afterwards 2/3 at both sizes. No claim of
  aggregate speedup is made for this candidate.
- Remove duplicate traversal-cache freshness check: overall 1.0018
  [0.9977, 1.0038], rejected and reverted.
- Canonical parent lookup, private helper: overall 0.9947 [0.9932, 0.9992],
  independent repeat 0.9963 [0.9924, 1.0023]. This form exceeded bundle budgets.
  Sharing parent calculation with validated public dirname fits all original
  budgets (29 bytes smaller than round two), but final-form overall 1.0005
  [0.9964, 1.0036] is neutral. Rejected and fully reverted; no CF deployment.
- Point publication with change feeds enabled: native workerd rename reads
  126/1026 -> 23/23 beside 100/1000 unrelated files; statements 18 and writes
  16 unchanged. Feed content/order, inode and both mutation tokens are verified.
  The source shares present/absent subtree publication and is smaller; all
  unchanged bundle budgets, full Node/Workers suites and native POSIX pass.
  Full aggregate local comparison and actual CF validation remain pending.
- Exact runtime graphs are losslessly archived in compiled-graphs.json.gz.
  Baseline contains full JavaScript; named graphs are changed/deleted paths
  relative to baseline. archive-graphs.mjs reconstructs each graph in memory
  and verifies its recorded SHA256. This retains rejected graph variants too.

- Git synchronous-stat fast resolution: full incremental ten-pair overall
  1.0009 [0.9943, 1.0025]; rejected and reverted. Existing asynchronous error
  handling remains intact.
- Root-pinned FIFO traversal cache: 256-entry bound and focused behavior pass;
  overall 0.9979 [0.9943, 1.0008], five SQL flags. Insufficient benefit; rejected
  and fully reverted to full-clear eviction.
- Round-two actual CF UID/GID1000 full ten pairs: overall 0.9577
  [0.9496, 0.9723], files 0.8889 [0.8735, 0.9220], Git 0.9686
  [0.9582, 0.9858], cache 0.9316 [0.8993, 1.0098]. Native profile reads
  8185228 -> 1993959 (-75.6%), statements 553153 -> 551818, writes unchanged
  at 227815. Sixteen pointwise signals, two confirmed (coding-mixed add-partial
  and add-rest, 100 files, ratios 1.0833 and 1.1414); eight SQL flags remain.
  User-approved geometric-mean tradeoff policy applies; unbound CF control
  is running before public adoption.
- JSON single-entry envelope prototype: generated immutable JS graph from
  point-change-feed baseline, same fixed nineteen scalar SQL fields. Full
  local UID ten-pair overall 0.9075 [0.9036, 0.9113]; native CF benefit unknown.
  Node's expensive per-column output conversion may explain much of this gain.
  A failed initial field-count assertion (expected 20, actual 19) aborted
  preparation; its accidentally started unchanged-code trial was stopped and
  discarded before results. Corrected prototype was fully prepared and run.
- Source implementation shares a fixed scalar field projection for normal and
  JSON selects. parseEntry keeps all existing field validation. Combined next
  round includes this envelope, indexed descriptor lookup and point change-feed
  publication. Full Node/Workers suites, native POSIX 46/46, SQL guards 39/39 and
  all original bundle budgets pass (core VFS exactly 213504 bytes). Final-form
  local comparison is in progress; none of these next-round changes is adopted.
  Round-two and round-three TS snapshots are frozen in owned worktrees.

## Round-two adoption checkpoint

Adopt canonical ancestor lookup, ASCII normalization, bounded fresh directory
metadata reuse, indexed recursive copy and point rename publication. No API
addition; existing bundle budgets remain unchanged. Primary actual-CF ten-pair
full-suite latency ratio is 0.9576677 [0.949583, 0.972269], or 4.42% higher
reciprocal geometric-mean score. Native all-190-stage reads fall 8185228 to
1993959, statements 553153 to 551818, writes unchanged (227815).

The unbound ten-pair control ratio is 0.9877238 [0.974929, 1.022618]; this
is inconclusive for improvement. Its reads fall 5042149 to 993442; statements
increase 370226 to 370257 and writes remain 216461. Per-stage flags are
retained in raw results. Independent ten-pair investigation of the two
confirmed primary coding-mixed-100 signals produces zero confirmed flags.
Unbound flagged groups are undergoing independent repetition. Adoption follows
the user's aggregate-score policy, rather than asserting every stage improves.

Round-three JSON envelope/descriptor/change-feed and round-four point-copy
changes remain experimental and frozen separately. Round-three local ten-pair
ratios versus round two: demo 0.945607 [0.944019,0.954846], unbound 0.963455
[0.952854,0.973480]. Round-four incremental demo ratio 0.996379
[0.994606,1.002613] is inconclusive; unbound cumulative 0.966161
[0.956701,0.971026]. Point-copy native reads 240/2040 become 34/34 for
100/1000 unrelated entries, with statements and writes unchanged. Round four
exceeds two existing bundle caps (raw VFS +244 bytes versus round three);
no budget has been changed and CF validation is still required.
