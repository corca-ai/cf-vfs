# Bash word expansion optimization — 2026-10-11

Scope: improve the existing bounded Bash profile without extending filesystem
APIs, weakening execution limits, or adding persistent parser/session caches.
The implementation change is confined to `src/shell/brace.ts`.

Baseline production source: `ea1b5dc` (checkout `5ba007f`). Final compiled graph:
`e1d5e34f4825b4602e845d29ee77a7fc547620d53a239354d4e059f64a33ae90`.
Complete source graphs, raw measurements and reproduction instructions are in
[bash-2026-10-11](bash-2026-10-11/README.md).

## Changes and compatibility

Before testing whether a word contained an expandable opening brace, the shell
flattened every unquoted literal into one object per Unicode code point.
Ordinary arguments and long literal bodies therefore paid for brace parsing
that could do no work. The new test searches unquoted literal parts with native
`String.includes` first. Words without a brace retain the exact original parsed
word; brace-bearing words still use the bounded existing expander. Quoted and
escaped braces and expansion-produced braces keep their existing semantics.

Three reproduced Bash mismatches were fixed with initially failing tests:

- Mixed digit/letter endpoints and non-ASCII endpoints stay literal, matching
  Bash: `{1..a}`, `{a..1}`, `{é..ê}`.
- An overflowing signed 64-bit stride stays literal, instead of silently
  producing a truncated range through JavaScript number conversion.
- Letter ranges crossing ASCII backslash retain an empty argument at that
  position, in both directions, instead of emitting a literal backslash.

A fourth new test protects padding, negative/zero strides and quoted list
alternatives. All four groups match installed Bash **5.3.20**, with `LC_ALL=C`
and `TZ=UTC`. This is additional differential evidence, not regeneration against
the repository's pinned `bash:5.3.3` image: Docker is unavailable. The unchanged
pinned fixture set passes in the ordinary suite. Integer endpoints retain their
existing safe-integer limit; this is still the declared finite Bash profile.

The actual public WebSocket shell was checked before deployment: it reproduced
all three defects; only the normal padding/stride/quoting control matched.
Post-deployment verification is recorded below.

## Local measurements

Twenty alternating measured pairs after three warmup pairs, same fixed five
scripts, default budgets, parsing plus execution, exact stdout/status/stderr
verification. Lower candidate/baseline time ratio is better.

| Shell workload | Baseline median ms | Candidate median ms | Paired median ratio | 95% paired CI |
| --- | ---: | ---: | ---: | --- |
| ordinary literal arguments | 5.33 | 4.35 | 0.8152 | [0.7988, 0.8239] |
| 4 KiB literal repeated 150 times | 7.42 | 4.64 | 0.6250 | [0.6043, 0.6394] |
| quoted and parameter words | 2.80 | 2.71 | 0.9572 | [0.9253, 0.9864] |
| functions and arithmetic | 5.77 | 5.60 | 0.9767 | [0.9589, 0.9997] |
| real brace expansion | 3.42 | 3.42 | 0.9974 | [0.9888, 1.0154] |

Geometric mean of the five paired workload median ratios: **0.8617**, or
**13.8% less time** (score +16.0%; aggregate CI [0.8519, 0.8723]). This separate shell aggregate does not change
the workload membership or weighting of the established FS/Git aggregate.
Raw pairs: `local-final.json`.

A separate CPU profile of 150 verified long-literal executions sampled the
brace module 271 times before and twice after. It supports the allocation-path
explanation; it includes startup and is not another paired latency experiment.
For the long literal alone, each script previously created 614,400 character
atoms (4096 × 150) that it discarded immediately.

Both full local controls use ten alternating pairs, the complete 190-workload
plan, fixed Git time, independent fixtures, body verification and separate SQL
profiling. Credential-bound overall time ratio: **0.9961**, CI
**[0.9939, 0.9984]**; unbound: **1.0054**, CI **[0.9958, 1.0146]**.
Cache-family ratios: 1.0003 and 1.0131 respectively, both inconclusive.
The two credential-bound and eleven unbound >5% timing flags contain **zero
confirmed individual regressions**; no SQL statement/returned-row increases.
All flags remain in the raw complete comparison outputs. The unbound screen is
inconclusive; it does not establish an improvement for that control.

## Actual Cloudflare evaluation

Final source is frozen for the controlled CF comparison. The private Worker
runs the full existing comparison on one DO, with alternating full suites and
separate native SQLite profiling. Shell scripts run separately afterwards to
avoid benchmark overlap, with twenty executions per RPC and twenty alternating
pairs after three warmup pairs. Caller RPC wall time divided by twenty includes
RPC overhead; it is not isolated CPU time.

Final CF shell results (per-execution caller RPC wall time):

| Shell workload | Baseline median ms | Candidate median ms | Paired median ratio | 95% paired CI |
| --- | ---: | ---: | ---: | --- |
| ordinary literal arguments | 14.28 | 12.98 | 0.8663 | [0.8190, 0.9400] |
| 4 KiB literal repeated 150 times | 22.30 | 13.38 | 0.6017 | [0.5264, 0.6309] |
| quoted and parameter words | 10.15 | 11.13 | 1.0675 | [0.9131, 1.2484] |
| functions and arithmetic | 26.38 | 22.98 | 0.8562 | [0.7987, 0.9482] |
| real brace expansion | 17.13 | 14.43 | 0.8395 | [0.8018, 0.9274] |

Geometric mean of the five paired workload median ratios: **0.8325**,
**16.7% less time** (score +20.1%; aggregate CI [0.7959, 0.8768]).
Aggregate CIs resample matched pairs within each independently timed workload,
then recompute the same geometric mean of workload median ratios;
`summarize-shell.mjs` and `shell-summary.json` retain the calculation.
Four workload CIs support improvement.
Quoted/parameter words have an inconclusive +6.7% point estimate; it is retained,
not described as faster. Ratios use matched pair medians, so they need not equal
the ratio of the two independently computed median durations.

Full existing CF control: ten alternating complete pairs, 190 workloads.
Uncached overall ratio **1.0142**, CI **[0.9981, 1.0213]**; files **1.0184**,
CI **[0.9961, 1.0344]**; Git **1.0170**, CI **[0.9943, 1.0200]**; cache **0.9983**,
CI **[0.9918, 1.0161]**. These controls are inconclusive, including the overall
+1.4% point estimate; this experiment does not establish FS/Git acceleration.
There are seventeen >5% flags. Two initially have CIs entirely above 1:
`coding-small:100:false/status-clean` (1.0701, CI [1.0154, 1.1180]) and
`status-dirty` (1.0984, CI [1.0189, 1.1600]). They trigger a separate twenty-pair
repeat of the complete `coding-small:100:false` group. The original full score
and flags remain intact; selected repeats never replace full-suite results.

Every workload has identical native SQL costs. Uncached totals are 438,595
statements / 1,706,463 reads / 182,971 writes for both versions; cache totals
are 72,665 / 247,932 / 44,844 for both. Caller requests were observed at LAX;
DO placement is requested with a `wnam` hint rather than asserted from that
caller colo.

The separate twenty-pair complete-group repeat did **not reproduce** either
initial signal: clean status ratio **1.0251**, CI **[0.8562, 1.1031]**; dirty
status **0.9524**, CI **[0.8397, 1.0739]**. The repeated group has no confirmed
material timing regression and identical SQL costs. Its own aggregate is
0.9887, CI [0.9672, 1.0315], and is not substituted for the original full score.

**Adopt:** the targeted shell geometric mean improves locally and on CF with
aggregate CIs below 1, and the existing full-suite controls show no persistent
confirmed material regression or SQL increase. The original inconclusive
FS/Git +1.4% point estimate, seventeen flags, initial two signals, and
inconclusive quoted-word result remain disclosed. This establishes a shell
optimization; it does not establish that every shell or FS/Git workload speeds
up.

Exploratory `cf-preliminary.json` belongs to the earlier graph, before the
crossing-backslash fix, and overlaps a private harness redeployment. Its shell
geometric ratio was 0.9739, with both improvements and slowdowns. It is retained
but is not used as the final adoption run. An initial full-suite harness attempt
incorrectly invoked destructive validation after every stage; that harness was
fixed before the final run. This was an evaluation harness error, not a library
change.

## Validation and deployment

- Node: 1,992 tests, 105 files, four workers.
- Workers: 158 tests, 15 files.
- POSIX differential: 46/46.
- Typecheck, separate private Worker typecheck, lint, knip, quality, execution
  limits, docs, package consumers and benchmark protocol checks pass.
- Twelve tree-shaking/bundle budgets remain unchanged and pass. The
  non-interactive shell preset is 238,970 / 248,704 bytes.
- Lint/quality retain the existing unused NUL-regex suppression warning and
  existing benchmark informational suggestions; no new errors.

Code committed and pushed as **3c7e04473a57414b3fd86cf3910e4d197cde5097**.
Public `https://vfs.borca.ai/` deployment version:
**cf2050f1-d1fe-45f1-88fe-29dba91bd7f5**. Expected build:
**b729287aa1c4f3d3a701b9a7cbfc742464fbecce66a923d14c4dab183ead3bcd**.

The authenticated full public run verified that build and commit, completed
at **2026-10-11T09:19:11.642Z**, run
**bcecdcbe-ebfa-413e-bbfb-5e9791b03939**, with **60,648 checks** and **190 rows**.
Public WebSocket Bash verification matches all four groups, versus one of four
before deployment. `public-smoke.json`, `public-candidate.json.gz`,
`public-comparison.json` and `public-deployment.json` retain the evidence.

The three-sample public comparison against the prior archived deployed run has
ratios overall **0.9482**, files **0.9635**, Git **0.9461**, cache **1.0114**,
with **47 >5% flags** and **zero unresolved measurements**. These are descriptive
history values, not confidence-backed adoption evidence. In particular,
`git-recovery/partial-add-retry` has a 2.00x public point estimate (624 to
1249 ms). The controlled full CF comparison for that workload is 0.9711,
CI [0.8958, 1.0160], with identical SQL costs; the local unbound control is
0.9165, CI [0.8560, 1.0490]. Those controls do not confirm a persistent regression,
and the credential-bound CF comparison does not independently establish its
unbound performance. All public flags remain available instead of being
suppressed or described as universal improvements.

The temporary authenticated evaluation Worker was deleted, its rooms cleared,
and owned compiled/profiling temporaries removed. Immutable graphs,
declarations, profiles and paired measurements remain archived for review.
No npm release was made; the package version remains 0.4.2 with an Unreleased
changelog entry.
