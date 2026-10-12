# Permission-bound task measurement and metadata reuse experiments

Library baseline: b99327ffbab56ed510f107a554e0508d6b66e10d (no library changes
since 4e449bb). The new task fixture is frozen independently of the 190-row
public suite. Existing reference/fixture hashes remain unchanged.

## Preselected evaluation

- Three consecutive complete A/A task runs before optimization, followed by
  three runs per candidate if local whole-task and full-suite results justify CF.
- Three complete original-suite runs for baseline and accepted candidate, with
  fixed-reference and previous-version run-cluster assessment. No selective
  omission of noisy rows or runs. Every >5% flag requires independent review.
- SQL costs are a separate untimed replay. All bodies, clean state, outputs and
  commit identities must match; POSIX and bundle budgets remain adoption gates.
- Existing local task script adds SQL-query frequency diagnostics. Its raw
  baseline profile is instrumented, not an uninstrumented latency claim.

## Measurement implementation

The new endpoint `/api/benchmarks/task` uses its own coordinator/scratch object
names, protocol hash and frozen reference. It reuses durable job/TTL/history
storage. No library or FS API change is involved. The task is status, 20 edits
among 1,000 files, verification, add and commit under UID/GID 1000. Each arm is
fresh, warms two distinct-content cycles, and measures a third complete cycle
in one RPC. SQL meters are created only for a separate replay.

Local Workers integration completed 28,028 validations across seven pairs
(one warmup and six measured). This precommit integration uses the old generated
build label and is not production performance evidence. SQL medians match in
both arms: 3,560 statements, 8,281 rows read, 520 rows written.
The full check passed 2,055 Node tests, 158 Workers tests, POSIX oracle and all
12 unchanged bundle budgets. Browser smoke checks cover task UI and scripts.

## Early local experiments (not adoption evidence)

The first 30-pair task prototype reduced latency 52.71 → 43.67 ms, paired
ratio 0.82755 [0.80393, 0.84826]. After moving shared SQL read state into its
own module, a separate 30-pair task run gave 50.48 → 42.68 ms, ratio 0.84400
[0.83526, 0.85314]. The former full-suite screen overlapped test execution
in early pairs; its raw results are retained as preliminary.

The subsequent isolated 20-pair full suites did not establish an aggregate
win: bound 0.97044 [0.93929, 1.00930], unbound 0.97779 [0.94386, 1.00911].
They exposed repeated large-add timing flags. Empty Map.clear calls in every
transaction were suspected; invalidation now releases the snapshot instead.
A separate 20-pair repeat of git-shell/1000 and git-recovery/100 found no
confirmed flags and no SQL-cost increases. This does not establish causality
or replace full-suite evidence. Final full suites preselect 40 pairs per
credential mode after this source change.

The task's production A/A calibration contains three consecutive runs,
18 pairs total: index 100.967, run-cluster 95% CI [95.477, 106.773].
All 84,084 validations pass. Every arm has the same 3,560 native SQL
statements, 8,281 rows read and 520 rows written. No speedup is claimed.

A final-check attempt encountered three workerd internal errors; its next
performance-pool startup failed to load cloudflare:test-internal. Earlier
complete checks had passed 2,057 Node / 159 Workers tests. The owned local
Wrangler dev process was stopped; these infrastructure failures must be
resolved before accepting the final candidate.

## Consistent local aggregation

The legacy local harness reports the median of per-pair aggregate ratios, with
bootstrap intervals for that median. Production uses a mean of log paired
ratios. `assess-local.mjs` retains the legacy results and reanalyzes all raw
pairs with the production statistic, equal workload weights and no trimming.
It marks the interval **within one local session**, not independent sessions
or production adoption evidence. The union of legacy >5% and mean-log >5%
flags remains in the review list.

For the 40-pair EOF-read candidate, the consistent overall index is 97.432
[96.057, 98.827] bound and 97.824 [96.101, 99.578] unbound. In the bound run,
order-specific overall indices are 93.749 and 101.259; both balanced orders
remain included. A median across this bimodal mixture was especially unstable.
The raw reference/candidate arrays, old statistic and new statistic are all
preserved, rather than selecting only whichever summary favors the candidate.

The subsequent whole-body variant also consumes an existing batch snapshot
before the unbound direct-read query. Previously that path ignored the snapshot
and fetched metadata again with the body. This variant aims to cover cold
hashing/remote-tree inspection as well as EOF authorization on warm hash hits.
It still performs current access checks and materializes an immutable body
snapshot; mutations and rollback invalidate all unconsumed batch metadata.

## Final local whole-body candidate

The final 30-pair task gives marginal medians 48.773 → 41.552 ms and a paired
median ratio 0.84646 [0.83508, 0.86801]. Full 20-pair controls, analyzed with
mean log ratios, give overall indices 97.507 [95.302, 99.763] bound and 96.977
[94.938, 99.060] unbound. These are within-session intervals; CF run clusters
are still required for adoption. Cached-family intervals include 100.

Independent ten-pair repeats include all >5% mean-log or legacy timing flags,
plus cost flags, and the initially suspicious shell/recovery groups: 136 bound
and 126 unbound stages. Neither statistic confirms a >5% timing slowdown in
these repeats. Bound Node cost samples retain small increases: 5 returned rows
in direct add-all/1000, 1 in cached add-all/1000, and 5 statements/2 returned rows
in mixed clone/100. They remain review signals for native CF cost verification;
Node returned-row counts are not billed CF reads. No unbound cost increases
remain in either final full run or selected repeats.

The final full check passes 2,058 Node / 159 Workers tests, POSIX oracle and
all twelve unchanged budgets. The performance guard passes all 45 Workers
cases. The earlier workerd startup/internal failures did not recur after the
owned development server was stopped. That timing is recorded, not asserted
as a proven root cause. The source is a candidate until CF gates complete.
