# Three-hour optimization session

Start: 2026-10-10 06:06:50 UTC. Deadline: 2026-10-10 09:06:50 UTC.
Baseline: 02f2ef3 (library unchanged since 0c544003).
Authorization: user requests continuous incremental optimization for three hours,
local full-suite success before actual CF validation, retain only proven CF wins.
No new filesystem API. POSIX and comprehensive regression protocol are mandatory.

Current work: profile full public local plan; prepare immutable baseline.

06:32 UTC: Entry Object.assign, ancestor slicing, sync materialized bytes,
and ASCII comparator candidates were neutral in full 190-workload ten-pair
local screening; none sent to CF. Raw results and patches retained.
Batch parent lookup reuse completed 20 local timing pairs, under review.
Current working source is separate empty-tombstone-cache candidate, compiled.
Immutable baseline /tmp/cf-vfs-3h-baseline-1791612409, backups /tmp/vfs-3h-*.
Private CF full paired harness prepared; not deployed yet. COLOCATED=1 uses
one DO with full-suite reset between each version, alternating complete runs.

06:40 UTC: Private evaluation Worker deployed version
8e57390f-3293-48dc-8043-1a56be2ba36f, batch-parents-v1.
Running full colocated CF ten-pair suite, warmup1 + separate profilepair.
Local known-absence candidate reduces 413014→405542 statements but overall
latency inconclusive; global empty-table flag only removes70 statements after
fixture removals and adds startup lookups, not worth retaining.
One-chunk collect helper full20 local pairs: order-balanced overall ratio
0.9903 CI[0.9834,0.9980]; needs independent confirmation. Cache-only controls
also shifted, so do not yet claim this a supported library improvement.
Observed repeatable order bias (first version slower); next local protocol
alternates order per stage AND pair. A/A calibration currently running.
Current source has parents + known-absence + single-chunk candidates combined,
not adopted; compiled independent graphs retained for all candidates.

06:43 UTC: Combined parents/known-absence/one-chunk candidate passes 1961
Node tests and155 Workers tests. Two initial failures were an expected lower
SQL-statement budget and an incorrectly timed new quota-callback test; the
latter was changed to a binary single write so the mutation occurs after the
absence read. Existing typed-view/stream race tests pass unchanged.
Now measuring combined candidate with per-stage order alternation,40 pairs.
A/A under that protocol is neutral: overall1.0019 CI[0.9929,1.0126].
CF parent-only full comparison remains running; public deployment unchanged.

06:55 UTC: First combined per-stage-order40-pair local run nearly neutral:
overall0.9963 CI[0.9904,1.0002], three >5% flags, none confirmed, no SQL cost
increase. Do not call this a proven overall latency improvement.
Fused credential-bound read candidate reuses the existing stat ancestor JSON
query. workerd actual-cost comparison: whole3→2 statements and EOF2→1;
rowsRead exactly unchanged at depths1/16/64 (8/53/197 whole,7/52/196 EOF),
zero writes. Full190-workload ROOT-credential local20-pair run now ongoing,
baseline is combined3 candidates without fused read, so the new effect is isolated.
Found and fixed missing final deadline check in single-chunk prototype; use
compiled/final-v2 for final comparisons. New late-EOF deadline/lease test added.
Current source is four candidates + final deadline fix, all unadopted.

07:03 UTC: Narrow final candidates to parent-cache + single-chunk collection
(with final deadline check preserved) + fused POSIX reads. Known-absence cache
is NOT retained: added invalidation complexity without supported full latency
or billed-row improvement. Original SQL-write planner restored, budgets10/20
restored. Old final-v3/v4 local runs interrupted while reviewing quality/design;
their partial checkpoints are not evidence of approval.
Isolated fused-read ROOT20-pair run: overall0.9870 CI[0.9841,0.9890], but three
confirmed >5% Git regressions. Investigation found a redundant requireEntry
query after the fused query had already proven the path absent. Final version
throws ENOENT only AFTER checking ancestor permissions, avoiding that second
lookup. New one-statement missing-read/EACCES guard added.
Shared stat/read canonical eligibility helper removes duplication and meets
quality complexity ceilings. Final-v5 graph is compiled. Current full20-pair
unbound local run uses final-v5; need complete ROOT run against02 baseline too.
Current source passes1963 Node+155 Workers, quality. POSIX/bundle/full gates
still needed after local timing window. CF parent-only10 pairs nearing profile.

07:23 UTC: Fixed Git identity fixtures copied into BOTH source graphs; baseline
library remains02f2ef3. Public default Git time unchanged; shell budget clock
still real. New identity fixture test passes. Final fixed unbound20 pairs:
overall0.9976 CI[0.9918,1.0053], two flags/one confirmed, zero cost increases.
Final fixed ROOT20 pairs: overall0.9787 CI[0.9758,0.9829], three flags/one
confirmed(partial-add-retry1.109 CI[1.047,1.174]), zero cost increases.
ROOT flagged groups now30-pair local followup. CF fixed combined candidate
full10 unbound pairs running, deployed privately as three-candidates-fixed-v1,
versione941f8f3-d3c0-43e4-8a0e-4c30e246134b. Public unchanged.
Full final typecheck/lint/quality/knip,1964 Node+155 Workers tests, POSIX,
protocol, docs/package/execution-limits and12 bundle budgets passed.

07:35 UTC: Both original local fixed flags followed up with30 alternating pairs
of complete affected groups; unbound followup0 flags0 cost increases, ROOT
followup0 flags0 cost increases. ROOT partial-add-retry now0.926 CI[0.887,0.991],
so original slowdown was not reproduced; do not make an isolated speed claim.
One-entry validated-path cache isolated full20: overall0.9911 CI[0.9789,0.9973],
three flags none confirmed, no cost increases. Combined4 full20: overall0.9976
CI[0.9843,1.0015], five flags one confirmed(status-clean mixed100); not approved.
Incremental path-cache comparison vs final3 is running; frozen main source and
current private CF deployment remain final3. No source candidate adopted.

08:47 UTC: Final experimental source is bounded POSIX traversal-parent metadata
reuse + single-chunk collector; path-string cache and all earlier SQL/batch
candidates rejected. V1 local UID1000 full20 pairs overall0.8263; V2 adds shared
binding generation/depth guards, UID1000 full10 overall0.8294 CI[0.8252,0.8366],
unbound full10 neutral0.99985 CI[0.99264,1.00796]. V2 guarded tests1967 Node+
156 Workers, all46 POSIX,31 workerd performance guards,12 bundle budgets pass.
TDD warm-read budget failed3vs2 before implementation, passes after. New symlink
test initially used reversed API operands; fixed test, no library workaround.
Warm500-stat workerd rows at depths1/16/64 reduced3500/26000/98000 ->500 each;
listing statement budget tightened to trusted count. Shared instances/rollback
DO test passes. No FS APIs/schema changes. Main source fingerprint1d3d16785aef...
Private Worker version542381ea-4e4a-4aee-84f3-3702e22e09d9,
labeltraversal-cache-v2-1d3d16785aef. Full CF UID1000 five pairs+warmup+profile
running. First3 full timing pairs overall0.9001 CI[0.8896,0.9265], preliminary
only. Full unbound CF control, flagged-group followups and post-public deployment
remain. No source adoption/production deployment yet.
Local original flags each investigated in30 alternating complete-group pairs;
no confirmed flags or SQL increases. Residual diff/add-all flags have wide CIs.
Completed raw JSON and patches losslessly gzip-archived; inventory supports gzip.
A short candidate-graph compilation overlapped an earlier40-pair timing window;
raw samples were retained, not selectively removed. Final V2 timing windows
were separated from compilation/tests/compression.

Final decision after the optimization window: rejected all runtime candidates.
Independent second ten-pair CF confirmation reproduced 1000-file shell populate
regression 1.1859 CI[1.0737,1.2599]; first ten-pair followup 1.1223
CI[1.0349,1.2149]. All twenty matched pairs 1.1390 CI[1.0797,1.2014].
Full UID1000 CF five-pair aggregate 0.8896 and rows read -21.91% did not override
this regression. Library source and SQL guards restored to baseline. Keep
behavior-only permissions/rollback tests and optional fixed Git identity clock
in private measurement fixtures. No production deployment; final checks pending.

Private evaluation Worker deleted successfully. Restored Node1964/Workers156, POSIX46 and workerd31 pass; no library diff.

Subsequent user-approved adoption: restored exactly the measured v2 source
patch (bounded POSIX traversal metadata + one-chunk collector). Adopted source
commit08b8e0b77759ca30539a1e369921b594a48c0aae, public build8b69f3aaaa96cff14269623ff1ec7cdb48ca1b0c99e18774017d2d5310fc3fa2,
Worker version36d44b2b-452c-4eb2-b58a-fc5faddb50e1. Public full190/60648 checks
and shell clone/pull/chmod smoke pass. User prioritizes the proven UID1000
full geometric mean improvement over accepted individual latency tradeoffs.
Additional full unbound CF10 pairs overall0.9924 CI[0.9764,1.0071], neutral;
all190 SQL costs match exactly370226/5042149/216461. Public35 descriptive flags
not confirmed in paired control; new control3 latency signals5–8% remain
disclosed in report. Candidate Node1967/Workers156/POSIX46/workerd31/bundles12
pass. Recreated temporary evaluation Worker deleted and both test rooms cleared
with explicit HTTP200 verification. No other rejected optimization adopted.
