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

## Not yet done

The candidate is not deployed: `deploy:public` records the measured commit and
refuses an uncommitted tree. Remaining steps after committing:

1. `npm run deploy:public`, then verify the deployed build id.
2. `npm run bench:public -- --task --out cf/candidate-task-{1,2,3}.json`.
3. `npm run bench:public -- --out cf/candidate-1.json` (control).
4. Assess with `bench:assess:paired`; escalate per the scoping rule if the
   control leaves the baseline spread.
