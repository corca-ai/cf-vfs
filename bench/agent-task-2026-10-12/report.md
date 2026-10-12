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
