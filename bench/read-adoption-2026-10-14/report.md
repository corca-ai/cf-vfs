# Accepted guarded metadata reuse: production adoption

Status: the user explicitly accepted the original four documented latency signals. The exactly measured candidate `8f25ac0` (library tree `dd68928483bd5534173a37d04a202b8f1a75e302`) was adopted as `3d81df3` and deployed. Five complete public full runs supported a 2.908% overall normalized gain but found three additional unaccepted regression signals. The prior library was therefore restored as `c61c21f` and deployed publicly. No FS API/schema/configuration change remains. The restored deployment passed demo Git smoke and local/CI checks, but its one full verification attempt failed with an unknown cause; this reliability limitation remains unresolved. All candidate and failed-attempt evidence is retained.

## Accepted evidence

The [original evaluation](../read-retry-2026-10-13/report.md) and all raw data remain available. Same-private-topology full overall index is 98.155 [96.988, 99.336] (1.845% improvement); Git/coding/recovery is 97.898 [96.670, 99.142]. The separate task fixed-reference index is 89.485 [84.067, 95.254]. These are normalized paired indices, not established absolute-time speedups across environments.

The user accepted clone-worktree/100 index 116.700, add-changed/100 index 116.185, cached commit-one/1000 index 105.868, and coding-small edit/1000 index 105.044, with their original intervals and absolute diagnostics in `acceptance.json`. This is acceptance of this documented experiment, not a blanket waiver for future changes.

Three full native CF audits of this exact library source found no per-workload increases: statements 332,303 → 332,303; rows read 743,361 → 731,142; rows written 186,801 → 186,801. All 30 separately warmed task replay pairs recorded statements 3,560 → 3,560, rows read 8,281 → 6,301 (−23.91%), and writes 520 → 520. Statement counts and latency do not establish dollar savings.

## Production verification plan

`plan.json` is fixed before deployment/data collection: five complete full public suites followed by three complete task suites, sequentially, preserving all samples. Full runs 4–5 provide twelve additional alternating pairs per workload for confirmation. Compare with the three retained public baseline full runs and five baseline task runs; keep frozen references unchanged and inspect absolute times, family indices, every workload and both-arm RPC controls. The four accepted cases remain visible in the analysis. An additional or materially worse confirmed regression remains subject to investigation/reversion.

Finish deployment before any run; no deployment or live-log attachment/detachment during the cohort. Verify every result's build, source, deployment and distinct run identity. Native task cost replays remain separate from uninstrumented timing. Post-deployment source/build and results will be recorded here without pooling private and public runs.

## Deployed source and smoke verification

Adopted on main as `3d81df3cde4e8eada5fec4955b48d2ce1408aa19`, with [CI 38503101968](https://github.com/corca-ai/cf-vfs/actions/runs/38503101968) successful. Local checks passed 2,064 Node tests, 159 Workers tests, 45 performance guards and 12 bundle budgets. All 194 library files match the measured candidate. Generated public build `24b227cf20a9224a0bfaf12a7057bc28292b691724a9d4dcfa8a98486683bb18` was deployed to the existing `cf-vfs-benchmark` Worker as deployment `202d7157-1751-4a5b-8c45-d38d485efbbb`; public full/task coordinators reported that build before measurement. Existing bindings, references and secrets were preserved.

`demo-smoke.json` records a successful real public demo WebSocket session exercising repository initialization, local author configuration, add, commit, clean status, local clone, file content verification and supported `git log -n 1 --oneline`. Test data used UUID paths and was removed, with absence verified in the same workspace. The initial smoke used an unsupported Git `-1` option and unsupported negated `test` syntax; that failed script and its separate successful cleanup are retained. Only the smoke commands were corrected; no source/runtime changes were made during measurement.

## Incomplete attempt and bounded retry

After three complete successful full suites, full-4 run `42c32845-0158-4acb-bcdb-cf6381b13162` failed after the last observed 40% progress. The public API exposes a generic failure only; the underlying cause is unknown. The failed snapshot, claim and original client log are retained separately. No complete sample is discarded. Before retrying, `incomplete-retry-plan.json` preselects exactly one unchanged-code replacement of this incomplete slot, followed by original full-5 and task1–3. A further execution failure stops verification for reliability investigation. No live-log attachment or deployment changes are made.

## Public production result and regression decision

All five complete full runs and all three complete task runs were retained and matched source/build/deployment identities. Full suites each verified 212,268 checks over 190 rows; task suites each verified 28,028 checks. One incomplete full attempt failed with an unknown cause and was replaced exactly once under the recorded bounded policy; no completed sample was discarded. Public full RPC medians were 14–15ms on both arms, versus 15ms in all baseline full runs. Task RPC medians were 23–23.5ms, consistent with baseline 23–24.5ms. No live logging, deployment or configuration changes occurred during the cohort.

Indices are equal-weight geometric paired ratios, previous public code = 100, lower is better. The public baseline has three full runs and five task runs; the candidate has five full and three task runs. Confidence intervals cluster independent runs, not within-run pairs.

| Metric | Index (95% CI) | Interpretation |
| --- | --- | --- |
| Overall, 146 uncached workloads | 97.092 [94.658, 99.588] | 2.908% normalized improvement supported |
| Files, 18 workloads | 95.378 [90.773, 100.217] | Improvement estimate, uncertain |
| Git/coding/recovery, 128 workloads | 97.335 [95.310, 99.404] | 2.665% normalized improvement supported |
| Metadata cache, 44 workloads | 100.066 [94.912, 105.499] | Uncertain |
| All 190 workloads, diagnostic | 97.773 [96.357, 99.209] | 2.227% normalized improvement supported |
| Agent task | 88.450 [69.869, 111.972] | 11.550% improvement estimate, uncertain |

The candidate/frozen-reference overall index is 98.509 [97.351, 99.682]; the public baseline/frozen index is 101.460 [98.558, 104.447]. Absolute both-arm full times also changed: unchanged frozen control 93.140 [85.789, 101.120], candidate 90.431 [83.080, 98.433]. Therefore the roughly 9.6% observed absolute decrease cannot all be attributed to this optimization. No RPC/GC subtraction is used.

All 18 new native task cost replay pairs returned exactly statements 3,560 → 3,560; rows read 8,281 → 6,301 (−23.910%); rows written 520 → 520. There were zero native task cost increases. Existing three full native CF audits of the exact candidate library remain separate evidence. Statement counts and measured latency do not establish dollar savings.

### Additional signals outside the accepted four cases

All 190 workload estimates, initial three-run results, independent final two-run confirmation results, absolute diagnostics and raw pairs remain available in the assessment and new-flag diagnostics. The combined intervals below are exploratory across 190 comparisons. Absolute uncertainty does not disprove a paired normalized slowdown and does not waive the gate.

| New stage | Previous-code paired index (95% CI) | Pooled candidate-time median |
| --- | --- | --- |
| git-shell populate/100, uncached | 121.892 [104.740, 141.852] | 111.5 → 104ms |
| git log/1000, cached | 110.597 [102.702, 119.099] | 20 → 20ms |
| coding-mixed checkout-main/100, uncached | 118.297 [104.268, 134.212] | 154 → 172.5ms |

Populate's unchanged reference arm became faster, absolute index 79.029 [66.411, 94.043], while its candidate absolute index is 96.330 [87.898, 105.570]. Its independent confirmation previous-code index is 130.531 [112.356, 151.647]. Cached log absolute index is 100.891 [80.739, 126.073], with independent confirmation 112.876 [99.613, 127.905]. Checkout absolute index is 109.892 [94.607, 127.645], with independent confirmation 126.922 [38.397, 419.541]; the 792ms sample remains included. These observations diagnose reference drift and variability but do not establish that the additional regressions are harmless. No original accepted case was materially worse by the preselected interval test.

The user was asked specifically about these three additional tradeoffs after full analysis. There is no additional explicit acceptance at this decision point. In accordance with AGENTS.md and plan.json, restore the previously qualified library rather than automatically extending the four-case acceptance. Candidate commit 3d81df3 and all evidence remain available for a future explicit decision. Rollback deployment and verification identities will be appended after completion.

Rollback predeployment checks passed: 2,057 Node tests, 158 Workers tests, 45 performance guards and 12 bundle budgets. Restored src and test trees exactly match preadoption main d0442cf. Evidence credential scanning passed without printing secrets.

## Rollback deployment

Rollback source `c61c21fe7883b254711b4762a74ad3fab1d18044` passed [CI 38514394447](https://github.com/corca-ai/cf-vfs/actions/runs/38514394447) and was deployed as `2c9c59b8-8ba0-448c-9740-59601d67e37b`. Its content fingerprint is exactly the previous qualified public build `6202f9e15d94839fc9e38617cad41db18a0aec1f54d93914e5572f539d2c0607`; library tree `8162c78bbdefd63417c83d0942716802985c3ff5` also matches the preadoption source. Existing bindings, secrets and configuration were preserved. `rollback-demo-smoke.json` confirms the public demo Git workflow still works and its UUID temporary files were removed. `rollback-verification-plan.json` fixes one complete deployment/correctness verification suite; it is not an optimization cohort or evidence of a new speedup.

### Rollback verification limitation

The one preselected rollback full suite (`2f9f7f6e-4159-450e-91a3-db755f04e89d`, deployment `2c9c59b8-8ba0-448c-9740-59601d67e37b`) failed after the last observed 92% progress. `rollback-public-full.json`, its claim and client log preserve this incomplete attempt. It is not a completed correctness or performance sample. The public API exposes only a generic failure, retains the previous saved result, and does not expose the underlying exception. A historical telemetry lookup after the client ended returned HTTP 403/code10000 with the current credentials (`historical-failure-lookup.json`). No live logging was attached and no automatic retry was made. Cause remains unknown; neither an infrastructure cause nor an optimization cause is established. This failure also occurred with the exactly restored previous build, so it must not be attributed solely to guarded metadata reuse.

Final state: public library source is restored to the previously qualified implementation, with unchanged FS APIs/POSIX surface, successful local checks, successful source CI and a passing real demo Git smoke. The optimization and all candidate full/task data are preserved in commits and this archive. **The restored deployment's full-suite verification did not pass; benchmark execution reliability remains unresolved and requires access to underlying failure diagnostics.** Do not describe the rollback as having passed a full post-deployment suite, or silently retry until favorable. The original user acceptance covered the documented four signals; the three additional public signals remain unaccepted at this recorded decision point. No additional source optimization is claimed as retained.
