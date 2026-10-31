# Runtime costs on Workers — evidence, 2026-10-31

The change (ebcca53) makes `utf8ByteLength` test for ASCII before encoding at
any length, splits `awk`'s default fields in one pass and skips empty flushes,
sends pipe writes straight to the readable side, and shortens two `awiki`
parse paths. `utf8ByteLength` is on the VFS path, so the full protocol applies.

Baseline: d83b254 (deployment 6ceadb3d), its three full runs from the
read-ahead cohort (`../read-ahead-2026-10-30/cf/candidate-{1,2,3}.json`) and
three agent-task runs (`../read-ahead-2026-10-30/cf/candidate-task-*.json`),
plus one fresh full run today (`cf/base-4.json`). Candidate: d99294d,
deployment d9d3e3e7, build abf55820….

## Cloudflare, full suite

| Metric | Candidate vs baseline (3 runs vs 4) |
| --- | ---: |
| Overall | 101.06 (96.69–105.62), uncertain |
| Files | 102.13 (97.98–106.46) |
| Git | 100.91 (96.05–106.02) |
| Metadata cache | 99.53 (91.80–107.92) |

Per run, against the fixed reference: candidate about 102.2, 102.8 and 99.2;
baseline 99.4 to 101.2. SQL statements, rows read and rows written are
unchanged in every workload. Two attempts at a candidate run failed on the
platform ("Durable Object instance is no longer active" at workload 46,
"Scratch fixture was interrupted" at 40) and are kept as `cf/failed-*`.

Three rows are flagged slower than the baseline: `git/diff/1000/cache` 116.7
(108.1–126.0), `coding-small/clone/1000` 111.5 (101.2–122.8) and
`coding-small/edit/1000` 122.7 (101.8–147.8). The baseline's own fresh run
flags two rows against its predecessor the same way. Investigated with ten
alternating pairs per session, both starting orders, on the local group
protocol (`local/flagged-pairs-{0,1}.json`, fixed Git time, compiled graphs of
b7940f8 and d99294d, SQL unchanged):

| Workload | Pairs | Geometric mean | Median |
| --- | ---: | ---: | ---: |
| git/diff/1000/cache | 20 | 1.062 | 1.019 |
| coding-small/clone/1000 | 20 | 0.999 | 0.997 |
| coding-small/edit/1000 | 20 | 0.974 | 0.993 |
| every workload of those groups | 540 | 1.001 | — |

`git/diff/1000/cache` takes 0.4 ms locally, at the timer's resolution; its
mean moves with one 1.1 ms sample, and nineteen of twenty pairs are equal or
within 0.1 ms. Nothing this change touches runs in it: paths are under 128
characters, which `utf8ByteLength` tested the same way before, and the Git API
workloads use no pipe.

## Cloudflare, agent task

`cf/candidate-task-{1,2,3}.json`: candidate vs baseline 114.35 (78.58–166.41),
uncertain; SQL identical. The same series read 89.26 for the previous change
against its baseline; it moves by that much between cohorts.

## Local full suites (descriptive)

`local/{candidate-1,base-1,base-2,candidate-2}.json`: the first run of the
session was slow (A/A candidate 0.771, base 0.906); the adjacent pair
base-2 → candidate-2 reads 0.988 overall with no SQL change.

## What it buys

[`../sql-lab/runtime-report-2026-10-31.md`](../sql-lab/runtime-report-2026-10-31.md),
paired in one Cloudflare deployment: `awk 'FNR == 1'` 0.645, `awk '{ print $1 }'
| wc -l` 0.734, cold `awiki lint` 0.889, `wc -l glob | tail` 0.929.

## Conclusion

No overall or per-workload regression is established: the overall interval
includes 100, the flagged rows do not reproduce in alternating pairs, and SQL
costs are unchanged. The point estimate of about +1% overall stays recorded;
the next cohort before a release repeats the full three runs.
