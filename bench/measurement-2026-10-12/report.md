# Paired benchmark measurement, 2026-10-12

This change repairs measurement; it makes no library acceleration claim.
The library source is unchanged from `cae52554` (implementation `4e449bb0`).

## Design

See [the protocol](../../docs/performance.md#fixed-reference-paired-production-measurement).
The demo bundles a frozen reference, compares alternating complete groups on one
scratch DO, and keeps coordinator/result I/O out of timed stage RPCs. Each run
contains one warmup pair plus six measured pairs for all 190 workloads. A single
commit point accumulates up to twelve full runs. Intervals use run clusters;
less than three runs stays provisional. The CLI separately compares the preceding
measured commit to prevent hiding incremental regression behind an old reference.

All samples survive, including zero timings; unresolved cohorts cannot become a
positive claim. Fixture, dependency and compatibility fingerprints guard the
reference. No filesystem API, library code or package bundle is changed.

## Verification

- `npm run check`: 2,043 Node tests, 158 Workers tests, POSIX oracle, protocol,
  documentation, package, type/lint and all twelve tree-shaking budgets passed.
- Actual local Workers integration through `bench/public-remote.mjs --url
  http://127.0.0.1:8795`: 190 rows, six samples per arm, 212,268 checks.
- Local clocks rounded some fast calls to zero: 24 rows unresolved. The UI and
  assessment correctly decline a full aggregate instead of excluding those rows.
- Local saved JSON is integration evidence only: it used an uncommitted working
  tree with the prior generated deployment label, not a production performance
  comparison. Browser checked workload selection, expanded history and absence of
  script errors.

## Production calibration

Both arms contain the same library code. Source commit `51767dac`, deployment
`cc5042d6-c7bb-4b6a-bdd2-d63e779dd8fd`, build
`b89c5b6a1d6353afcf023d33cf6c24ed24c63ffcf1fcef90e0d4a7be91a7c333`.
Three full A/A runs were selected before seeing the first result.

Run 1 completed `2026-10-12T05:50:13.375Z`, ID
`371857aa-9f70-4c8b-b4d0-5c0ac06e83ae`: 190 rows, 212,268 checks,
no zero durations. Overall index 100.829, provisional within-run 95% interval
99.603–102.070. Both reference and candidate no-op RPC medians were 14 ms.
This is calibration, not a measured library optimization.

The deployment initially served the new HTTP Worker with the old coordinator
DO. Build guards rejected measurement until they agreed; no mixed result was
published. An additional public POST during the active run returned 202 and
`reused: true`. The read-only progress response was 124 bytes.

Run 2 completed `2026-10-12T06:09:10.940Z`, ID
`977171fe-ee77-4fb1-88ef-c11a56fea984`: another 190 rows and 212,268 checks,
no zero durations. The two-run overall index is 100.516, with between-run
95% interval 96.627–104.563. The broader interval correctly accounts for only
two independent runs; twelve pairs are not twelve sessions. Both runs remain
in one commit point, and the history still contains ten distinct commits.
A public POST immediately after completion reused that run with HTTP 200;
`nextRunAt - modifiedAt` was exactly 600,000 ms. Authenticated evaluation then
started the third run without changing deployment or code.

Run 3 completed `2026-10-12T06:28:22.960Z`, ID
`ba1e3f4f-a553-4307-af5e-d6f9142710e3`. All three runs completed 190 workloads
and 212,268 checks each: **636,804 checks**, 18 retained pairs per workload,
no zero durations, one commit point. Each full run took approximately 19 minutes.
No additional runs were selected after seeing these results.

| Index (reference = 100; lower is faster) | Run 1 | Run 2 | Run 3 | Combined | 95% interval across runs |
| --- | ---: | ---: | ---: | ---: | --- |


| overall | 100.83 | 100.20 | 102.12 | 101.05 | 98.65–103.50 |
| files | 99.63 | 99.28 | 98.41 | 99.11 | 97.56–100.68 |
| git | 101.00 | 100.33 | 102.65 | 101.32 | 98.41–104.32 |
| cache | 101.49 | 99.33 | 100.19 | 100.33 | 97.67–103.07 |

All four aggregate intervals contain 100. The UI correctly says **No clear
difference**, and the assessment returns exit 2 rather than approving an
optimization. This validates the basic null control in these sessions; it does
not prove that all platform variance or module/JIT bias has disappeared.
The primary interval still spans roughly -1.3% to +3.5%, so a one-percent change
cannot be called an improvement from this evidence alone.

For example, comparing the first two runs' absolute candidate medians gives a
file-workload geometric-mean ratio of **103.86**. Their paired reference indices
were **99.63** and **99.28**. The same code therefore appeared about 3.9% slower
under that unpaired comparison, while the reference-adjusted comparison was
nearly unchanged. This is an observed example, not a general variance-reduction
percentage or a filesystem speedup.

## Remaining limits and adoption

The raw per-workload estimates remain noisy: 31 are more than 5% above the
reference; five of these have a pointwise 95% interval above 100. Across all
190 rows, twelve pointwise intervals exclude 100 (four faster, eight slower).
They are **investigative signals**, not evidence that identical library code
changed speed. These intervals do not control the family-wide false-positive
rate of inspecting 190 rows, and module layout/runtime conditions can introduce
bias. Do not use those labels alone to accept or reject an implementation.
Preselect affected workloads, confirm signals in independent matched sessions,
compare the previous commit as well as the frozen reference, and retain the
full-suite primary gate. The CLI keeps every >5% apparent slowdown in its
review list even when its interval overlaps 100; a test verifies that this
prevents an overall win from silently bypassing review.

The public suite measures unbound VFS operation RPCs, not native filesystem
latency, CPU time alone, permission-bound access or R2 transfers. No-op RPC
medians were 14/14, 14/14 and 13/14 ms for reference/candidate; they remain in
the evidence, without subtraction. Three consecutive runs describe these
sessions, not every region or load condition. SQL/billing and POSIX gates remain
separate from timing. Future changes must not repin the reference or cherry-pick
runs to erase a regression.

## Reproduction and artifacts

Run `npm run bench:public -- --out cf.json` three times against a committed,
deployed build, then `npm run bench:assess:paired -- cf.json assessment.json`.
The last snapshot contains all retained runs for that commit. Exit 2 is expected
for this unchanged-code control. The public page keeps its ten-minute cache;
authenticated evaluation bypasses freshness but coalesces active runs.

- [First CF snapshot](cf-1.json.gz), [second](cf-2.json.gz), [third](cf-3.json.gz)
  retain every raw pair, diagnostics and commit/build/deployment identity.
- [Calibration](calibration.json) and [assessment](assessment.json) contain the
  calculated statistics, including all review signals.
- [HTTP checks](http-checks.json) record concurrent-request coalescing, the
  600,000 ms TTL, and same-commit accumulation.
- [Previous legacy snapshot](prior.json.gz) preserves the pre-migration history.
- [Desktop](desktop.png) and [mobile](mobile.png) show the deployed final result.
  Browser checks covered workload selection, expanded confidence details,
  one point/three runs, legacy separation and no script errors.

The initial full check passed; follow-up statistics/gate tests (eight cases),
type checks and documentation checks also passed. The deployed source commit's
GitHub CI passed. No library API, library source or package bundle changed.

## CI follow-up

The evidence commit hit the pre-existing five-second timeout in the monolithic
100-file integration test; baseline commit `cae52554` had failed the same test
before this change. The test now executes each dependent operation group as its
own case, with fresh fixtures matching the production paired runner. Every
original stage and validation is retained; the timeout and assertions are not
weakened. This changes tests only, not the deployed benchmark or calibration.

The CLI's adoption policy is shared with its deterministic tests. Tests call
that policy directly instead of starting a Node subprocess whose startup time
can itself exceed a test timeout under load. The real CLI was also rechecked
against the archived CF snapshot and retained its expected exit-2 decision.

The final local `npm run check` passed 2,052 Node tests and 158 Workers tests,
along with the POSIX oracle, reference verification, documentation/package checks
and all twelve unchanged bundle budgets.
