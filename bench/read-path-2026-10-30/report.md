# Bulk reads for walks over many files — evidence, 2026-10-30

The change adds the optional `VirtualFileSystem.readMany` (two SQL statements
per 64 paths: entries as `ENTRY_JSON`, then the admitted bodies by id) and uses
it in `grep -r` and a cold `awiki` load, which consume the stored chunks without
a stream per file. `grep` also skips the line-by-line work for a bulk body that
lacks a literal every pattern requires, with identical charges and failures.
The shell's line splitter measures a line's UTF-8 length with an ASCII test
before encoding.

## Path

The 190 full-plan workloads run neither `grep -r` nor `awiki`, and `readFile`
is unchanged. The agent task series runs `grep -c`, `sed` and `cat`, which use
the changed line splitter. This is the off-path case of
[the scoping rule](../../docs/performance.md#scope-the-cloudflare-evidence-to-the-change):
three task-series runs per version and one candidate full-suite control.

## Baseline (30c9e66, deployment 182725fa, build 0755c510…)

Full suite, three runs (`cf/base-{1,2,3}.json`; assessments beside them),
fixed-reference overall ratio as runs accumulate: 99.53, 99.50, 99.66
(95% CI 98.96–100.37 over three runs).

Agent task, three runs (`cf/base-task-{1,2,3}.json`): 103.08, 101.68, 94.74
(95% CI 69.7–128.7 over three runs) — the task series is noisy.

Two earlier attempts at the third full run failed and are kept as diagnostics
(`cf/failed-base-3a.*`, `cf/failed-base-3b.*`, `cf/failed-runs-telemetry.json`:
"Network connection lost" at workload 55, "Scratch fixture was interrupted"
at workload 18). Both coincided with deploys of the separate SQL lab Worker;
no lab deploy ran during the retained runs.

## Local full suites (descriptive screening)

`local/{candidate-1,base-1,base-2,candidate-2}.json`, run in that order on one
machine, 190 workloads each. Overall geometric-mean ratios: base→candidate
0.948 and 1.158; A/A base 0.908, A/A candidate 1.111. The change is inside the
local spread, as expected for a plan that never calls `readMany`. Statement
differences of a few per Git workload appear in the A/A pairs as well
(`FIXED_GIT_TIME` was not set), so they are not attributable to the change.

## What the change does where it runs (SQL lab, Cloudflare)

[`../sql-lab/report-2026-10-30.md`](../sql-lab/report-2026-10-30.md), 10,000
pages, medians of three alternating trials, same output in every pair:

| Command | Per file | Bulk |
| --- | ---: | ---: |
| `grep -rlF '[[note-0001' /wiki` | 8.5 s | 1.7 s |
| `grep -rc '^owner:' /wiki` | 12.7 s | 6.4 s |
| `awiki lint -r`, empty cache | 13.1 s | 6.9 s |

## Candidate (f1f4f03, deployment 738da88c, build b9c0315f…)

Full-suite control (`cf/candidate-1.json`): fixed-reference overall 99.73
(within-run CI 95.5–104.1), against baseline runs of about 99.5, 99.5 and
100.0; previous-commit ratio 100.07. Files 100.75, Git 99.59, metadata
cache 102.61. SQL statements, rows read and rows written are unchanged in
every one of the 190 workloads, as between the baseline runs. Raw timings
drift by up to 1.5x between runs of the same build (`cf/desc-*.json`), which
the reference-paired design absorbs; only paired values are compared.

Agent task (`cf/candidate-task-{1,2,3}.json`): per-run paired geometric means
1.125, 1.152 and 1.037 against 1.031, 1.003 and 0.822 for the baseline;
pooled previous-commit ratio 116.5 with a 95% CI of 83.3–162.9, status
uncertain. SQL is identical (3,560 statements, 8,281 rows read, 520 written
per cycle). The candidate arm's medians are 535, 547 and 574 ms against 580,
569 and 535 ms for the baseline; the geometric means move with single
samples of 900–1,486 ms on either side.

Because the point estimate exceeds 5% on a workload that runs changed code
(the line splitter, through `grep -c`, `sed` and `cat`), it was investigated
with alternating paired trials of the same agent task locally
(`bench/agent-task-2026-10-12/local.mjs` on compiled graphs of 30c9e66 and
f1f4f03, ten pairs per session after two warmups, two sessions,
`local/agent-task-pairs-{1,2}.json`):

| Phase | Session 1 | Session 2 |
| --- | ---: | ---: |
| inspect | 0.991 (0.954–1.004) | 0.971 (0.880–1.005) |
| edit (`sed`, `cat`) | 0.968 (0.919–1.054) | 0.991 (0.908–1.036) |
| verify (`grep -c`) | 1.010 (0.867–1.069) | 0.992 (0.922–1.049) |
| stage | 0.992 (0.921–1.007) | 0.996 (0.985–1.010) |
| commit | 0.973 (0.949–1.031) | 1.009 (0.988–1.045) |
| total | 0.982 (0.941–0.999) | 0.996 (0.938–1.004) |

No phase slows down. The control run shows no departure from the baseline
A/A spread and no SQL change, so the scoping rule does not escalate to the
full three-run protocol. The Cloudflare task-series result stays recorded as
uncertain; alternating Cloudflare deploys would be the next step if it needs
settling there.
