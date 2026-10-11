# Non-interactive agent shell optimization, 2026-10-11

This evaluation targets independently executed agent scripts using the shipped
utilities, rather than interactive session latency. Exact sources, graph hashes,
raw samples, oracle results, profiling and full-suite controls are archived in
[the evidence directory](agent-shell-2026-10-11/README.md).

Baseline: `180702f`, runtime source `3c7e044`. No filesystem API, persisted schema,
command registry or dependency changes. The existing public 190-workload score
and historical sparklines retain their cohort.

## Workloads and implementation

The task mix covers a small manifest, twenty small jq command substitutions,
escaped JSON, long Unicode metadata strings, a 300-dependency object, sed source
editing followed by grep, a cat/sort/uniq pipeline and a named Bash script that
combines jq, redirection, sed, grep and command substitution. The large metadata
fixture deliberately stresses long JSON strings; it is not a typical package.json.
The dependency fixtures cover many ordinary short keys/values instead.

CPU profiling of the initial five-workload mix identified JSON string scanning,
rendering and temporary text allocations. The final implementation scans ordinary
JSON string spans with a reader-local regexp cursor and preserves each span in
one slice. Rendering replaces only the characters that require escaping, retaining
unescaped spans together. Native JSON.parse is not used: number spellings and
integer-like member insertion order still match this jq profile. Existing escape
validation, UTF-8 byte offsets, nesting, work and allocation budgets are unchanged.

The rendering-only experiment and parser/escape-check intermediate experiment
are retained separately. The final span renderer additionally improved escaped
JSON locally. Eight workflows were then expanded to ten to check dependency
objects and reassess small-command performance; earlier results remain labelled
as their original eight-workload cohort.

## Measurements

The initial final-candidate eight-workload local run recorded ratio 0.6511
(95% bootstrap CI 0.6338–0.6713). Its CF counterpart recorded 0.8750
(0.8619–0.8961): 12.5% less time, or 14.3% higher inverse-time score.
These are separate agent-workflow geometric means, not the public FS/Git score.
CF uses caller Worker RPC wall time per execution, not CPU-only time.

That CF run flagged twenty small jq substitutions at 1.0581
(CI 1.0286–1.1124); this is retained as a regression flag for follow-up.
The ten-workload local run recorded ratio 0.6894; dependency inspection was
0.7782 and dependency roundtrip 0.7558. Small-command and non-JSON controls
had confidence intervals spanning one.

Full existing local controls (190 rows, ten alternating pairs) recorded
credential-bound uncached 0.9988 (0.9940–1.0090), cache 1.0021
(0.9981–1.0157); unbound uncached 1.0015 (0.9956–1.0128), cache 1.0064
(0.9721–1.0158). No material latency regression was confirmed.

The preliminary credential-bound cost screen flagged three additional Node
returned rows in add-changed. The final bound comparison had no cost flags;
the unbound comparison flagged clone-worktree +5 statements/+2 returned rows.
Fixed-clock replay and same-build A/A controls retain all differences. Existing
Git writes use timer-based bounded batching, so a single cost profile may vary;
Node returned rows must not be described as native billed SQL rows.
A ten-pair SQL trace replay recorded clone differences of **-5 statements/-2
returned rows**, opposite to the original flag. The differing statements were
one BEGIN/COMMIT pair, usage read/update and parent timestamp publication: one
extra existing bounded checkout-write transaction. A/A controls also reproduced
add-changed row variability. This follow-up explains the local cost variation;
it is not a claim that every original cost counter was equal.

## Final ten-workload target comparison

The final target geometric ratio is **0.6894 locally** (95% CI
0.6752–0.7036) and **0.8928 on CF** (0.8706–0.9105). CF execution time fell
10.7%; the inverse-time score rose 12.0%. Neither aggregate is the existing
public FS/Git score.

| CF task | Baseline median ms | Candidate median ms | Paired ratio | 95% CI |
| --- | ---: | ---: | ---: | --- |
| Dependency inspection | 4.87 | 3.82 | 0.774 | 0.737–0.845 |
| Dependency roundtrip | 10.28 | 7.59 | 0.755 | 0.704–0.776 |
| Small manifest | 1.38 | 1.36 | 1.038 | 0.913–1.117 |
| Twenty small jq substitutions | 10.13 | 10.20 | 1.012 | 0.941–1.066 |
| Escaped JSON | 4.31 | 4.28 | 0.976 | 0.930–1.017 |
| Long-string manifest inspection | 2.38 | 1.95 | 0.837 | 0.728–0.905 |
| Long-string manifest update | 5.84 | 4.35 | 0.730 | 0.705–0.782 |
| Sed edit / grep | 5.10 | 5.27 | 1.054 | 0.982–1.160 |
| Cat / sort / uniq | 13.03 | 12.92 | 1.022 | 0.953–1.067 |
| Bash file combining utilities | 10.35 | 8.40 | 0.816 | 0.782–0.859 |

Ratios are medians of matched ratios, so they need not equal the quotient of
the two independently computed medians. Both versions have equal native SQL
counts in every measured target sample. Body validation runs separately after
each case. The original tiny-command flag did not reproduce; the sed point
estimate exceeded +5%, but its twenty-pair CI includes one. No final target
material regression is confirmed. Escaped JSON and the non-JSON controls do
not have a demonstrated CF speedup in this final run.

## Complete CF regression control

The complete credential-bound 190-row, ten-pair comparison recorded uncached
146-row ratio **1.0143** (95% CI **1.0038–1.0287**). This is a small measured
slowdown, not an inconclusive speedup. Files: 1.0244 (0.9885–1.0490); Git:
1.0076 (1.0035–1.0348); cache: 1.0025 (0.9941–1.0474).
The full timing includes the SQL meter symmetrically for both implementations.

There were 36 >5% point-estimate flags, eight initially confirmed: Git shell
100-file init, push-one and add-removals-repeat; cached rename at 100 and 1,000
files; cached Git 100-file checkout-main; mixed coding 1,000-file prepare and
clone. The complete matching groups were repeated independently. A group
follow-up is not substituted for the full 1.0143 aggregate.

Every native per-workload SQL counter was identical. Uncached totals for each
version: 438,595 statements, 1,706,463 rows read, 182,971 rows written. Cache
totals: 72,665 statements, 247,932 reads, 44,844 writes. These counters do not
establish a dollar savings percentage.

Independent follow-up and adoption results follow.

## Independent follow-ups and adoption

All eight initial full-suite flags failed to reproduce in an independent
ten-pair comparison of their complete groups. Two further ten-pair group
comparisons retained the raw evidence rather than replacing the full score.
Pooling the three forward phases left cached 100-file read at 1.0541
(1.0088–1.0871); commit-partial and add-rest were not confirmed material
regressions. See `pooled-followups.json`.

A twenty-pair byte-identical baseline A/A control produced the same cached-read
point ratio, 1.0541, with CI 0.9452–1.0720. A fifty-pair import-slot crossover
then ran the new implementation in the original baseline slot: the raw
old/new ratio was 1.0333 (0.9466–1.1231), reversing the apparent direction.
The conditional crossover code ratio is 1.0100 (0.9705–1.0606), assuming a
stable multiplicative slot effect across deployments. This diagnostic is
neither a replacement full-suite aggregate nor proof of 5% noninferiority.
All native counters remained equal. Sources and raw data for both controls
are archived alongside `crossover.json`.

Adopted for the demonstrated agent-script improvement, with no persistent
library-specific cached-read penalty established by these controls. The
original full FS/Git +1.4% slowdown and pooled raw read flag remain visible;
this is not a claim of universal acceleration or proven zero regressions.
Public deployment verification is recorded below after deployment.
