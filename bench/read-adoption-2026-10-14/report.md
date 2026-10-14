# Accepted guarded metadata reuse: production adoption

Status: the user explicitly accepted the four documented per-workload latency signals and authorized adoption/deployment. The library is exactly measured candidate `8f25ac0` (`dd68928483bd5534173a37d04a202b8f1a75e302`); no new FS API, schema, fixture, dependency or runtime compatibility setting is introduced. Public post-deployment verification is pending.

## Accepted evidence

The [original evaluation](../read-retry-2026-10-13/report.md) and all raw data remain available. Same-private-topology full overall index is 98.155 [96.988, 99.336] (1.845% improvement); Git/coding/recovery is 97.898 [96.670, 99.142]. The separate task fixed-reference index is 89.485 [84.067, 95.254]. These are normalized paired indices, not established absolute-time speedups across environments.

The user accepted clone-worktree/100 index 116.700, add-changed/100 index 116.185, cached commit-one/1000 index 105.868, and coding-small edit/1000 index 105.044, with their original intervals and absolute diagnostics in `acceptance.json`. This is acceptance of this documented experiment, not a blanket waiver for future changes.

Three full native CF audits of this exact library source found no per-workload increases: statements 332,303 → 332,303; rows read 743,361 → 731,142; rows written 186,801 → 186,801. All 30 separately warmed task replay pairs recorded statements 3,560 → 3,560, rows read 8,281 → 6,301 (−23.91%), and writes 520 → 520. Statement counts and latency do not establish dollar savings.

## Production verification plan

`plan.json` is fixed before deployment/data collection: five complete full public suites followed by three complete task suites, sequentially, preserving all samples. Full runs 4–5 provide twelve additional alternating pairs per workload for confirmation. Compare with the three retained public baseline full runs and five baseline task runs; keep frozen references unchanged and inspect absolute times, family indices, every workload and both-arm RPC controls. The four accepted cases remain visible in the analysis. An additional or materially worse confirmed regression remains subject to investigation/reversion.

Finish deployment before any run; no deployment or live-log attachment/detachment during the cohort. Verify every result's build, source, deployment and distinct run identity. Native task cost replays remain separate from uninstrumented timing. Post-deployment source/build and results will be recorded here without pooling private and public runs.
