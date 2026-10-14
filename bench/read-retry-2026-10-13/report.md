# Ranged-read metadata reuse: correctness, measurement and CF evaluation

Status: evaluation completed with a supported same-topology overall gain and four documented latency risks. The user explicitly accepted this tradeoff on 2026-10-14. Candidate `8f25ac0` was adopted as `3d81df3`, but subsequent public verification found three additional unaccepted workload signals and requires restoring the prior library; [adoption and public verification](../read-adoption-2026-10-14/report.md) records the acceptance, deployment and post-deployment results. The original measurements and held decision below are preserved as the evaluation history.

## Change and safety boundary

Git's cached-content path performs an EOF read to check current read access and metadata. The SQL backend can reuse a canonical inline-file metadata projection already loaded by `statMany`, once, without fetching and copying the same row again. The cache holds at most 1,000 projections, no bodies or authorization verdicts. Whole-file reads retain the existing fused metadata/body query. There is no new filesystem API or schema.

Metadata reuse must still access storage. An initial implementation (`4104095`) returned an EOF result after real SQLite storage closed, while the baseline threw. It also missed a permission mutation installed at the next SQL access. Two new real-SQLite tests pass on the baseline and fail on that implementation. All its candidate measurements, including its completed first clean CF full run, are excluded from adoption and preserved in `storage-fence-exclusion.json`.

The corrected candidate executes `SELECT 1 LIMIT 0` through the ordinary SQL API before using a projection. The probe returns no rows. Failure clears the batch and propagates; a mutation during the probe changes the batch identity and forces ordinary resolution. Read/search permissions are checked for the current principal. Transactions invalidate the batch before entry, after the callback and on commit failure; population/reuse is disabled inside callbacks. Query observers cannot restore an invalidated snapshot. Complex paths, links, directories and opaque content retain ordinary resolution.

Cloudflare documents that an old DO event can continue after replacement and learn this on storage access. The correction retains that access, rather than relying solely on in-memory state. See [global uniqueness](https://developers.cloudflare.com/durable-objects/platform/known-issues/) and the [SQL API implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.c%2B%2B).

The candidate branch contains `5760157`, `987825c`, `4104095` and the storage-fencing correction `8f25ac0`. `fenced-provenance.json` identifies the actual candidate source tree, patch and deployed build; intermediate measurements are not pooled with it.

## Local measurements used for the decision

The canonical paired local tool is now `npm run bench:local:paired`. Its `local-group-v1` protocol mirrors the CF structure: fresh SQLite fixtures per arm/group, a complete group before switching arms, untimed setup/validation/cleanup and a separate instrumented SQL replay. The fixture limits match CF. The local engine is Node SQLite; local returned rows are not CF billed rows.

The preselected main cohort has four complete sessions per credential mode, six alternating pairs per session, two warmups, all 190 workloads, fixed Git identity time and starting offsets `[0,1,0,1]`. Both library graphs are compiled once and immutable. Baseline is `2700b6d`, candidate `8f25ac0`. The indices below are candidate/baseline × 100; lower is better. Intervals use independent run means as clusters.

| Index | Unbound, 95% CI | UID/GID 1000, 95% CI |
| --- | --- | --- |
| Overall, 146 uncached workloads | 98.129 [97.647, 98.613] | 98.145 [97.555, 98.738] |
| Files | 99.713 [98.443, 100.999] | 100.029 [98.804, 101.268] |
| Git/coding/recovery | 97.908 [97.476, 98.342] | 97.883 [97.149, 98.622] |
| Optional metadata cache | 100.376 [98.401, 102.391] | 99.671 [98.677, 100.676] |

Thus the local full-suite improvement is about 1.86–1.87%. File/cache families remain uncertain. Every per-session/full >5% flag and SQL-counter flag received two additional preselected ten-pair sessions with opposite starting offsets; two full A/A sessions per mode use separately compiled identical baseline code. Plans and all raw results live in `local-fenced-group-*`.

A separate credential-bound task session has 30 alternating pairs: baseline median 48.006 ms, candidate 40.491 ms; median paired ratio 0.84296. Its within-session interval is 0.83629–0.85218, not an independent-session production confidence claim. Native CF task runs provide the production check.

A separate three-pair instrumented task replay records:

| Node diagnostic counter per cycle, median | Baseline | Candidate |
| --- | ---: | ---: |
| SQL API calls | 3,781 | 3,781 |
| Returned rows | 7,243 | 5,263 |

The corrected candidate claims fewer metadata rows/copies, not fewer SQL calls. Instrumented timings are excluded from the latency comparison. CF statements, rows read and rows written are reviewed separately. Three complete native audits produce identical totals: 332,303 statements → 332,303; 743,361 rows read → 731,142 (−1.64%); 186,801 rows written → 186,801. There are zero per-workload increases across all 190 workloads in all three audits (`cf-fenced-cost-assessment.json`).

The five complete CF task sessions also contain separate, equally warmed native-cost replays. All 30 replay pairs are identical: 3,560 statements → 3,560; 8,281 rows read → 6,301 (**−23.91%**); 520 rows written → 520 per coding cycle. These credential-bound task counts are distinct from the unbound full-suite totals and from Node returned-row diagnostics. `cf-fenced-task-cost-summary.json` preserves every replay; their timings are never substituted for uninstrumented latency.

## Original cross-topology CF cohort (diagnostic)

The public baseline is unchanged: build `6202f9e15d94839fc9e38617cad41db18a0aec1f54d93914e5572f539d2c0607`, deployment `c1082afc-dea0-489a-b78a-d66bd3ccd2fc`. Three full runs and all five preselected tasks completed.

The private candidate used build `44923cbdfc4ffca108ed19b2b8fbfb5f4225a74ed7520b6314cc51e68f54eafd`, deployment `4241d751-694f-46ce-9b92-9c6a6321c498`, source `8f25ac0afe02186cfdcee6665de469085270731a`. Untimed propagation probes for Git engine and shell groups verified the build before the cohort. No deployment or live-log changes occur during measurements.

`cf-fenced-plan.json` preselects five complete candidate full runs, three initial candidate tasks, three full native SQL audits and four extra tasks in baseline/candidate/candidate/baseline order. All five task runs per version contribute. Candidate full runs 4–5 are preselected independent confirmations. All complete runs are retained; no stopping on favorable results, trimming, zero replacement or reference repinning.

Five-run CF indices against the frozen reference are overall 98.263 [97.099, 99.440], files 99.810 (uncertain), Git 98.047 [96.864, 99.244] and metadata cache 99.396 (uncertain). The full-suite previous-code index is 96.849 [94.417, 99.343], about 3.15% improvement. All five task sessions per version and all three native-cost audits are complete without cost increases. This is not adoption approval.

The original cross-topology assessment flagged two signals. Uncached reads of 100 files have fixed-reference index 107.662 [105.006, 110.386], while the unchanged baseline A/A was already 115.402 [107.213, 124.217]; previous-code index 93.293 [87.728, 99.211] improves. Uncached shell-Git population of 100 files has previous-code index **125.896 [112.747, 140.578]** (initial and independent confirmation both slower), despite candidate/reference index 100.996 [96.329, 105.888]. Its baseline A/A index is 80.222 [70.450, 91.349]. Absolute candidate time is 137.808 [129.649, 146.479]% of the public baseline period; reference absolute time is 109.462 [88.811, 134.913]%. This material signal cannot be silently waived by the overall mean. The four-session local group comparison for this workload is 100.007 [98.087, 101.963] unbound and 100.950 [99.547, 102.372] credential-bound; neither reproduces a material slowdown. This motivated, but did not substitute for, CF topology calibration.

`cf-private-calibration-plan.json` preselects three complete coordinator full runs of unchanged baseline library source in exactly the same private Worker entry/configuration after the current cohort completes. This diagnoses topology/calibration effects; it neither replaces nor pools with the original public baseline. The historical unchanged-source sensitivity (`cf-historical-populate-calibration.json`) is also retained separately, with no adoption weight. No direct `/repeat` diagnostic is used because it can change runner placement.

RPC diagnostics reveal a concrete cohort difference (`cf-rpc-topology-diagnostics.json`): public baseline median RPC pings are 15 ms in all three runs; private candidate medians are 70–72 ms in all five runs, on both arms. Edge colos vary independently and are not the unknown runner/DO locations. Cloudflare’s [data-location documentation](https://developers.cloudflare.com/durable-objects/reference/data-location/) describes best-effort hints that only affect the first access; reusing a hint does not relocate an existing DO. Timed RPC operations include those waits. Additive transport delay need not cancel in ratios, so cross-topology absolute and normalized differences cannot be assigned wholly to code. No ping subtraction or sample removal is performed. The unchanged-source private calibration keeps the Worker/DO names and configuration, and records its pings as well.

Overall absolute times also drift: the frozen-reference arm is 128.761% of the earlier period, and the candidate arm is 124.703%. Both are slower in absolute time across periods. Report normalized paired improvement separately from those absolute values.

Baseline A/A is overall 101.460 [98.558, 104.447], files 106.590 [100.711, 112.813], Git 100.759 [98.247, 103.335] and cache 101.587 [95.595, 107.954]. The file-family skew remains visible. Rebuilding both frozen references from the baseline produces byte-identical bundles (`baseline-reference-rebuild.json`); no hidden library difference explains it. The final assessor reports frozen-reference, previous-code and absolute-time changes of both arms, not only a favorable reference index.

Five task runs per version give fixed-reference index **89.485 [84.067, 95.254]** and previous-code index **89.574 [83.319, 96.300]**, about 10.4% normalized improvement with no >5% flags. Absolute current-arm time is 96.400 [87.505, 106.199]% of the baseline period (uncertain); reference-arm absolute time is 107.620 [102.551, 112.940]%. Do not report the normalized 10.4% as an established absolute-time reduction across different RPC topologies.

## Same-topology result and adoption decision

All three preselected unchanged-source private calibration runs completed, with 190 rows and 212,268 checks each. The private deployment is `05ccdb27-bbe6-40fc-a6a6-40e74a5da958`, build `bc5b99c55134978faa0852a965168add99d2ef40750fd861c8ff1b37aefcd4bc`, source `7346d90827af10aac04a3c4fdef03e02d19a6364`. Its library tree `8162c78bbdefd63417c83d0942716802985c3ff5` exactly matches public baseline `2700b6d`; entry, configuration and dependencies match the candidate private deployment. RPC medians are 71–73 ms in both cohorts. No timings or pings are subtracted.

The original public/private comparison remains separate and unchanged. The same-topology full comparison is `cf-private-calibration-full-assessment.json` / `cf-private-calibration-full-comparison.json`.

| Same-topology candidate / previous-code index | Index | 95% CI |
| --- | ---: | --- |
| Overall, 146 uncached workloads | **98.155** | **96.988–99.336** |
| Files | 100.001 | 92.903–107.640 |
| Git/coding/recovery | **97.898** | **96.670–99.142** |
| Metadata-cache variants | 99.856 | 98.148–101.595 |
| All 190 workloads, diagnostic | 98.547 | 97.246–99.865 |

The supported overall gain is **1.845%**, rather than assigning the original cross-topology 3.151% wholly to library code. Same-topology unchanged-source overall A/A is 100.109 [99.338, 100.887]. Absolute current-arm full-suite ratio is 99.414 [95.696, 103.276], still uncertain. The former populate-100 previous-code flag becomes 100.260 [90.046, 111.634], uncertain: it is not a confirmed code regression under matching topology.

Four previous-code signals remain. All initial samples and the preselected independent full candidate confirmations 4–5 (12 additional alternating pairs per workload) are retained. Local comparisons do not reproduce material slowdowns, but that does not override the CF evidence. The confirmation-only intervals are wide; combined-session intervals below are unadjusted exploratory intervals across 190 workloads, not a proof of causality. These signals remain adoption risks rather than being discarded as noise.

| Workload | Relative index, 95% CI | Absolute median, baseline → candidate |
| --- | --- | --- |
| Shell Git worktree clone, 100 files | **116.700 [107.608, 126.561]** | 312 → 353 ms |
| Shell Git add all changed files, 100 files | **116.185 [100.586, 134.202]** | 374.5 → 393.5 ms |
| Git engine one-file commit, 1,000 files, metadata cache | **105.868 [100.368, 111.669]** | 157.5 → 165 ms |
| Small coding profile edit, 1,000 files | **105.044 [100.791, 109.477]** | 88 → 88 ms |

Absolute medians are descriptive and differ from geometric paired indices. Clone absolute-time ratio is also slower (118.292 [105.776, 132.288]); the edit absolute-time ratio is 104.200 [100.268, 108.286]. Add/commit absolute intervals remain uncertain. All are saved in `cf-material-tradeoffs.json`, without concealing the absolute/reference drift. The fixed-reference read-100 flag remains visible too; its same-topology previous-code ratio 103.847 [82.093, 131.366] does not establish a new material slowdown.

Overall and task gains plus native read-cost savings make the candidate reviewable, but AGENTS.md requires either no material unexplained regression or explicit acceptance of a documented per-workload latency tradeoff. No public deployment has occurred, no performance candidate was committed to main, and no post-deployment speedup is claimed. Candidate source is available on its pushed branch, with an independently verified main integration. If accepted, integrate that exact library tree, commit/push, deploy public and rerun the complete public CF suite for the new build before claiming production adoption. Otherwise keep production unchanged and retain this as a rejected experiment.

## Measurement corrections and preserved exclusions

Earlier live `wrangler tail` connections could themselves replace DOs. A sanitized log captured a reset because code was updated under the unchanged Worker version. Those cohorts are excluded by `tail-cohort-exclusion.json`, with failed attempts and sanitized benchmark-only logs retained. The CF documentation explains that enabling live logging requires a software update. AGENTS.md now prohibits instrumentation changes during a cohort.

The remote client retries read-only GET failures for the original run/build, saves its claim identity and retries POST only for explicit TCP `connect` failures proving that the request was never sent. A lost POST response after sending is not retried. A baseline task request stopped before connecting; server inspection showed the previous completed run and no new claim. The remaining preselected slots resumed, with evidence in `cf-clean-transport-recovery.json`. Cost audits share the same strict classifier.

The earlier local driver interleaved arms after every stage on long-lived fixtures. Strong first/second-arm effects occurred in a small Git diff case. Another initial signal came from the final measured pair: a separate GC diagnostic reproduced a candidate pause of about 0.60 ms, followed by baseline GC pauses of about 0.51/0.54 ms in later pairs. No pauses were removed or subtracted. Balanced old-protocol sessions and all diagnostics remain screening evidence; they are not pooled with the new group protocol. `local-fenced-group-plan.json` records the new cohort before its results.

The original broad reuse slowed a local mixed clone and was narrowed. Earlier local runs overlapped compilation or an orphaned process; their partial results and reasons remain archived. Compatibility failures take precedence over good timing. All rejected candidates and failed/transport attempts are preserved.

## Verification and decision

Corrected candidate: 2,064 Node tests, 159 Workers tests, 45 performance guards, POSIX/reference/package/protocol checks and all 12 bundle budgets pass. The integration on main was independently checked with `npm run check` and `npm run bench:check`; all 194 library source files match measured candidate `8f25ac0` exactly (`integrated-candidate-verification.json`). Root baseline also contains the two storage-lifetime guards (`8d47862`). Real HTTP tests cover GET recovery, lost POST responses and initial connection refusal; real SQLite protocol tests cover fresh per-arm/group fixtures, both starting orders and separate SQL instrumentation.

Root tooling/protocol commits are `306954f`, `6eb82da`, `d4ba63b`, `8d47862`, `aff94e0` and `4744801`. They have not deployed a library change to production.

Complete CF metrics, per-workload/cost review and integrated correctness checks are finished. Final adoption is held for explicit tradeoff acceptance; public post-deployment verification remains required if accepted. Raw evidence, driver scripts, plans and exclusions are adjacent to this report. Large completed JSON files are losslessly compressed and fingerprinted after collection; credentials are scanned before committing evidence.

## Cleanup

The private evaluation Worker was deleted after collection (`private-worker-cleanup.log`). Both owned worktrees, nine compiled graphs and raw authenticated tail logs were removed; graph byte fingerprints and sanitized tail diagnostics are retained. Both source branches remain pushed. The owned temporary secrets file was removed after scanning. The shared R2 bucket and user `.dev.vars.public` were preserved. A read-only public check confirms unchanged build/source/deployment (`public-unchanged-after-evaluation.json`). Main was rebuilt from unchanged baseline source; no candidate distribution artifacts remain active.

The first evidence-only main CI run (`38482754798`) hit the existing 5-second default timeout in the correctness test that validates all 19 shell-Git operations on 1,000 files. The library was unchanged. That one test now uses the existing coding-task integration budget of 20 seconds; all assertions and performance gates are unchanged. Its 20-test file passes locally. Failure and resolution logs are retained as `evidence-ci-timeout*`; the fix receives full CI verification.

Public adoption follow-up: the original four latency signals were accepted and candidate 3d81df3 was deployed. [Five full and three task public verification runs](../read-adoption-2026-10-14/report.md) supported a 2.908% overall normalized gain but found three new unaccepted workload signals. The production library is being restored under the regression gate. Historical raw data and the original qualification remain unchanged.
