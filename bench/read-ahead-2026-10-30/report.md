# Read-ahead for operand utilities — evidence, 2026-10-30

The change (2a268c7) reads file operands ahead with `readMany` in `cat`, `wc`,
`grep`, `sed`, `awk` and the other operand utilities, shares one `ReadAhead`
with `grep -r` and `awiki`, and hands out a body only while the new
`changeGeneration` has not moved. The SQL filesystem counts, in memory, every
statement that may change the storage: its `sql` handle is now a thin wrapper
that classifies each statement. That wrapper is on every workload's path, so
the full protocol applies: three complete Cloudflare runs per version.

Baseline: PR #124 (f1f4f03, deployment 738da88c). Candidate: d83b254,
deployment 6ceadb3d, build 931e21fb….

## Cloudflare, full suite

`cf/base-{1,2,3}.json` (base-1 is PR #124's control run) and
`cf/candidate-{1,2,3}.json`; assessments beside them. One candidate attempt
failed with "Network connection lost" at workload 26, with no lab deploy
running, and is kept as `cf/failed-candidate-3.*` and
`cf/failed-telemetry.json`.

| Metric | Baseline vs reference (3 runs) | Candidate vs reference (3 runs) | Candidate vs baseline |
| --- | ---: | ---: | ---: |
| Overall | 99.94 (98.15–101.77) | 100.88 (99.51–102.26) | 100.94 (99.26–102.64), uncertain |
| Files | 99.57 | 101.49 | 101.93 (88.66–117.19) |
| Git | 99.99 | 100.79 | 100.80 (98.51–103.14) |
| Metadata cache | 99.73 | 101.20 | 101.48 (91.59–112.44) |

SQL statements, rows read and rows written are unchanged in every one of the
190 workloads, between baseline runs and from baseline to candidate.

Three workloads are flagged slower than the baseline with intervals above 100:
`files/readdir/100/cache` 113.4 (103.8–123.8), `git-shell/add-unchanged/1000`
128.4 (113.2–145.5) and `coding-small/diff/1000` 118.2 (105.4–132.7). The
baseline cohort flags two rows the same way against its own predecessor
(`git-shell/clone-bare/100`, `coding-mixed/commit-partial/1000`), which is what
190 intervals at 95% produce by chance. Investigated with ten alternating
paired trials per session, two sessions with both starting orders, on the
local group protocol (`local/flagged-pairs-{0,1}.json`, `local-group-v1`,
fixed Git time, compiled graphs of 9ae5969 and d83b254, same SQL):

| Workload | Pairs | Geometric mean | Median |
| --- | ---: | ---: | ---: |
| files/readdir/100/cache | 20 | 0.990 | 1.002 |
| git-shell/add-unchanged/1000 | 20 | 0.995 | 0.989 |
| coding-small/diff/1000 | 20 | 1.008 | 1.005 |
| every workload of those three groups | 840 | 1.012 | — |

None slows down. The statement classifier costs about 40 ns per statement
locally (an allocation-free variant 30 ns), against statements of several
microseconds, which bounds what the wrapper can add at well under 1%.

## Cloudflare, agent task

`cf/base-task-{1,2,3}.json` (PR #124's candidate runs) and
`cf/candidate-task-{1,2,3}.json`: candidate vs baseline 89.26 (72.80–109.44),
uncertain, faster in point estimate; SQL identical (3,560 statements, 8,281
rows read, 520 written per cycle).

## Local full suites (descriptive)

`local/{candidate-1,base-1,base-2,candidate-2}.json` in that order: overall
base→candidate 1.030 and 1.004; A/A base 1.120 and candidate 1.091. Files
family 1.052 and 1.050 against A/A 1.034 and 1.031. Statement differences of a
few per Git workload appear in the A/A pairs too.

## What it buys

[`../sql-lab/report-2026-10-30.md`](../sql-lab/report-2026-10-30.md#operand-utilities):
over 8,055 operands on Cloudflare, `cat` 6.8 s → 1.9 s, `grep -lF` 9.3 s →
2.0 s, `grep -c` 13.1 s → 6.6 s, `wc -l` 7.4 s → 2.1 s.

## Conclusion

No overall or per-workload regression is established: the overall interval
includes 100, the flagged rows match the baseline's own false-positive rate and
do not reproduce in twenty alternating pairs each, and SQL costs are
unchanged. The candidate stays deployed.
